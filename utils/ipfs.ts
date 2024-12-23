import axios from "axios";
import path from "path";
import {
  generateEmbeddingWithRetry,
  MAX_TOKENS,
  splitTextIntoChunks,
} from "./openai";
import { executeQuery } from "./postgres";
import pQueue from "p-queue";
import { transformIpfsUrl } from ".";

const axiosInstance = axios.create({
  timeout: 30000,
  maxRedirects: 15,
  validateStatus: (status) => status >= 200 && status < 500,
});

const IPFS_GATEWAYS = ["https://gateway.autonolas.tech"];

interface GatewayStatus {
  url: string;
  failureCount: number;
  lastFailure: number;
  cooldownUntil: number;
}

type GatewayStore = Map<string, GatewayStatus>;

// Gateway management functions
const COOLDOWN_PERIOD = 60000; // 1 minute
const MAX_FAILURES = 3;

const initializeGatewayStore = (gatewayUrls: string[]): GatewayStore => {
  const store = new Map();
  gatewayUrls.forEach((url) => {
    store.set(url, {
      url,
      failureCount: 0,
      lastFailure: 0,
      cooldownUntil: 0,
    });
  });
  return store;
};

const getNextAvailableGateway = (gatewayStore: GatewayStore): string | null => {
  const now = Date.now();
  const availableGateways = Array.from(gatewayStore.values())
    .filter((gateway) => gateway.cooldownUntil < now)
    .sort(
      (a, b) => a.failureCount - b.failureCount || a.lastFailure - b.lastFailure
    );

  if (availableGateways.length === 0) {
    // Reset all gateways if none are available
    gatewayStore.forEach((gateway) => {
      gateway.cooldownUntil = 0;
      gateway.failureCount = 0;
    });
    return getNextAvailableGateway(gatewayStore);
  }

  return availableGateways[0]?.url || null;
};

const markGatewayFailure = (
  gatewayStore: GatewayStore,
  gatewayUrl: string
): void => {
  const gateway = gatewayStore.get(gatewayUrl);
  if (gateway) {
    const updatedGateway = {
      ...gateway,
      failureCount: gateway.failureCount + 1,
      lastFailure: Date.now(),
    };

    if (updatedGateway.failureCount >= MAX_FAILURES) {
      updatedGateway.cooldownUntil = Date.now() + COOLDOWN_PERIOD;
      updatedGateway.failureCount = 0;
    }

    gatewayStore.set(gatewayUrl, updatedGateway);
  }
};

// Response validation function
const isValidGatewayResponse = (response: any): boolean => {
  if (!response?.data) return false;
  if (response.status === 403) return false;

  const errorPatterns = [
    "blocked content",
    "forbidden",
    "ipfs cat",
    "error:",
    "<!doctype html",
    "<html>",
    "gateway timeout",
    "429 too many requests",
  ].map((pattern) => pattern.toLowerCase());

  if (typeof response.data === "string") {
    const lowerData = response.data.toLowerCase();
    return !errorPatterns.some((pattern) => lowerData.includes(pattern));
  }

  return true;
};

const gatewayStore = initializeGatewayStore(IPFS_GATEWAYS);

// Simplify the status enum
enum ProcessingStatus {
  PENDING = "pending",
  PROCESSING = "processing",
  COMPLETED = "completed",
  FAILED = "failed",
}

// Add retry delay configuration
const RETRY_DELAYS = {
  MIN_DELAY: 1000, // 1 second
  MAX_DELAY: 17500, // 17.5 seconds
  MULTIPLIER: 1.1,
};

// Add a new helper function for calculating retry delays
function calculateRetryDelay(attempt: number): number {
  const delay =
    RETRY_DELAYS.MIN_DELAY * Math.pow(RETRY_DELAYS.MULTIPLIER, attempt);
  return Math.min(delay, RETRY_DELAYS.MAX_DELAY);
}

async function determineCategory(contents: any[]): Promise<string | null> {
  const yamlFiles = contents.map((item) => item.name);

  if (yamlFiles.includes("contract.yaml")) return "contracts";
  if (yamlFiles.includes("protocol.yaml")) return "protocols";
  if (yamlFiles.includes("connection.yaml")) return "connections";
  if (yamlFiles.includes("skill.yaml")) return "skills";

  return null;
}

// Enhanced DB retry configuration with exponential backoff
const DB_RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelay: 4000,
  maxDelay: 20000,
  jitter: 0.25,
};

function calculateDBRetryDelay(attempt: number): number {
  const baseDelay = Math.min(
    DB_RETRY_CONFIG.baseDelay * Math.pow(2, attempt - 1),
    DB_RETRY_CONFIG.maxDelay
  );

  const jitter = baseDelay * DB_RETRY_CONFIG.jitter * Math.random();
  return baseDelay + jitter;
}

export async function safeQueueOperation<T>(
  operation: () => Promise<T>,
  attempt = 1
): Promise<T | null> {
  try {
    return await operation();
  } catch (error: any) {
    const isTimeout = error.message?.includes("timed out");
    const isConnectionError = error.message?.includes("connection");

    if (
      (isTimeout || isConnectionError) &&
      attempt < DB_RETRY_CONFIG.maxAttempts
    ) {
      const delay = calculateDBRetryDelay(attempt);
      console.log(
        `Database operation failed (${error.message}), attempt ${attempt}/${
          DB_RETRY_CONFIG.maxAttempts
        }. Retrying in ${Math.round(delay)}ms...`
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
      return safeQueueOperation(operation, attempt + 1);
    }

    // Log detailed error information
    console.error("Queue operation failed permanently:", {
      error: error.message,
      attempt,
      stack: error.stack,
      code: error.code,
    });

    return null;
  }
}

export const dbQueue = new pQueue({
  concurrency: 3,
  timeout: 120000,
  throwOnTimeout: true,
}).on("error", async (error) => {
  if (error.message?.includes("timed out")) {
    console.log(`Database operation timed out: ${error.message}`);
  } else {
    console.error(`Database operation failed:`, error);
  }
});

// Add new helper function to check if component is already processed
async function isComponentCompleted(componentId: string): Promise<boolean> {
  const result = await dbQueue.add(async () => {
    return await executeQuery(async (client) => {
      const response = await client.query(
        `SELECT COUNT(*) 
         FROM context_embeddings 
         WHERE id LIKE $1 
         AND type = 'component'`,
        [`${componentId}%`]
      );
      return parseInt(response.rows[0]?.count, 10) > 0;
    });
  });

  return result || false;
}
// Add a helper function for safe error handling
async function safeDownload(
  ipfsHash: string,
  componentId: string,
  retryAttempts = 15,
  attempts = 0
): Promise<void> {
  try {
    console.log(`Starting safe download for hash: ${ipfsHash}`);
    await traverseDAG(ipfsHash, componentId, "", {}, 25);
  } catch (error: any) {
    console.error(`Safe download failed for ${ipfsHash}:`, error);

    if (attempts < retryAttempts) {
      return await safeDownload(
        ipfsHash,
        componentId,
        retryAttempts,
        attempts + 1
      );
    } else {
      return;
    }
  }
}

export async function processPackageDownload(
  packageHash: string,
  configId: string
) {
  const transformedHash = transformIpfsUrl(packageHash);
  try {
    if (transformedHash) {
      void recursiveDownload(transformedHash, 20, configId);
    } else {
      console.log("No transformed hash found, skipping download");
    }
  } catch (error) {
    console.error("package hash download failed:", error);
  }
}

export async function recursiveDownload(
  ipfsHash: string,
  retryAttempts = 20,
  componentId: string
): Promise<void> {
  try {
    const isCompleted = await isComponentCompleted(componentId);
    if (isCompleted) {
      console.log(`Component ${componentId} already processed, skipping`);
      return;
    }
    await safeDownload(ipfsHash, componentId, retryAttempts);

    return;
  } catch (error) {
    console.error(`Failed to download ${ipfsHash}:`, error);
  }
}

// // Simplified retry function
// export async function retryFailedProcessing() {
//   const client = await pool.connect();
//   try {
//     const failedFiles = await client.query(
//       `
//       SELECT component_id, file_path
//       FROM code_processing_status
//       WHERE status = $1
//       AND updated_at < NOW() - INTERVAL '1 hour'
//       LIMIT 100
//     `,
//       [ProcessingStatus.FAILED]
//     );

//     for (const row of failedFiles.rows) {
//       try {
//         await recursiveDownload(row.component_id, 3, row.component_id);
//       } catch (error) {
//         console.error(`Failed to reprocess ${row.file_path}:`, error);
//       }
//     }
//   } finally {
//     client.release();
//   }
// }

// Add this utility function at the top of the file
function sanitizeContent(content: string): string {
  try {
    // Remove null bytes
    let sanitized = content.replace(/\0/g, "");

    // Replace invalid UTF-8 sequences with replacement character
    sanitized = sanitized.replace(/[\uFFFD\uFFFE\uFFFF]/g, "");

    // Handle control characters (except common whitespace)
    sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "");

    // Ensure the string is valid UTF-8
    return Buffer.from(sanitized).toString("utf8");
  } catch (error) {
    console.error("Content sanitization failed:", error);
    // Return a safe fallback
    return "[Content contains invalid characters]";
  }
}

// Update the processCodeContent function
async function processCodeContent(
  componentId: string,
  relativePath: string,
  cleanedCodeContent: string,
  ipfsUrl: string,
  gateway: string,
  cid: string
): Promise<boolean> {
  try {
    // Sanitize the content before processing
    const sanitizedContent = sanitizeContent(cleanedCodeContent);

    // Check if content is empty after sanitization
    if (!sanitizedContent.trim()) {
      console.warn(`Content for ${relativePath} is empty after sanitization`);
      return false;
    }

    const embeddings = await generateEmbeddingWithRetry(sanitizedContent);
    const fileName = path.basename(relativePath);
    console.log(`Processing ${fileName}`);

    const promise = await safeQueueOperation(async () => {
      return await dbQueue.add(async () => {
        if (Array.isArray(embeddings)) {
          const results = await Promise.all(
            embeddings.map(async (embedding, index) => {
              const result = await executeQuery(async (client: any) => {
                return await client.query(
                  `INSERT INTO context_embeddings (
                    id,
                    company_id,
                    type,
                    location,
                    original_location,
                    content,
                    name,
                    embedding,
                    is_chunk,
                    created_at,
                    updated_at
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())  
                  ON CONFLICT (id, type, location) DO UPDATE SET
                    content = EXCLUDED.content,
                    embedding = EXCLUDED.embedding,
                    updated_at = NOW()`,
                  [
                    `${componentId}-${index}`,
                    "olas",
                    "component",
                    ipfsUrl,
                    `${gateway}/ipfs/${cid}`,
                    sanitizedContent, // Use sanitized content
                    relativePath,
                    embedding,
                    true,
                  ]
                );
              });
              return result.rows.length > 0;
            })
          );
          return results.every(Boolean);
        } else {
          const result = await executeQuery(async (client: any) => {
            return await client.query(
              `INSERT INTO context_embeddings (
                id,
                company_id,
                type,
                location,
                original_location,
                content,
                name,
                embedding,
                is_chunk,
                created_at,
                updated_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())  
              ON CONFLICT (id, type, location) DO UPDATE SET
                content = EXCLUDED.content,
                embedding = EXCLUDED.embedding,
                updated_at = NOW()`,
              [
                componentId,
                "olas",
                "component",
                ipfsUrl,
                `${gateway}/ipfs/${cid}`,
                sanitizedContent, // Use sanitized content
                relativePath,
                embeddings,
                false,
              ]
            );
          });
          return result.rows.length > 0;
        }
      });
    });
    return promise || false;
  } catch (error) {
    console.error(`Failed to process code content for ${relativePath}:`, error);
    return false;
  }
}

// Update getContentTypeHeaders to be simpler
function getContentTypeHeaders(format?: string, useCache: boolean = true) {
  const formatMap: Record<string, string> = {
    raw: "application/vnd.ipld.raw",
    car: "application/vnd.ipld.car",
    tar: "application/x-tar",
    "dag-json": "application/vnd.ipld.dag-json",
    "dag-cbor": "application/vnd.ipld.dag-cbor",
    json: "application/json",
    cbor: "application/cbor",
    "ipns-record": "application/vnd.ipfs.ipns-record",
  };

  const headers: Record<string, string> = {
    Accept:
      format && formatMap[format]
        ? formatMap[format]
        : "application/vnd.ipld.raw",
  };

  if (useCache) {
    headers["Cache-Control"] = "only-if-cached";
    headers["If-None-Match"] = "*";
  }

  return headers;
}

// Add these new types
interface DAGNode {
  Links: Array<{
    Name: string;
    Hash: {
      "/": string;
    };
    Size: number;
    Type?: number | string;
  }>;
  Data?: any;
}

interface DAGResponse {
  Links?: DAGNode["Links"];
  Objects?: Array<DAGNode>;
}

interface IPFSContent {
  name: string;
  hash: string;
  size: number;
  type: number | string;
  isDirectory: boolean;
  contents?: IPFSContent[];
}

interface VisitedNode {
  timestamp: number;
  processed: boolean;
}

interface VisitedNodes {
  [cid: string]: VisitedNode;
}

// Update interface to handle different hash formats
interface IPFSLink {
  Name: string;
  Hash: {
    [key: string]: string; // Allow for different hash keys
  };
  Size?: number;
  Tsize?: number;
  Type?: number | string;
}

function formatLink(item: any): IPFSLink | null {
  try {
    // Ensure required properties exist
    if (!item || typeof item !== "object") {
      console.warn("Invalid link item:", item);
      return null;
    }

    // Normalize the name property
    const name = item.Name || item.name;
    if (!name || typeof name !== "string") {
      console.warn("Invalid or missing name in link:", item);
      return null;
    }

    // Normalize the hash property
    let hash = item.Hash;
    if (typeof hash === "string") {
      // If hash is a string, create an object with a default key
      hash = { "/": hash };
    } else if (hash && typeof hash === "object") {
      // If hash is an object, ensure it has at least one key with a string value
      const hasValidHashKey = Object.entries(hash).some(
        ([_, value]) => typeof value === "string"
      );
      if (!hasValidHashKey) {
        console.warn("Invalid hash format in link:", item);
        return null;
      }
    } else {
      console.warn("Invalid hash format in link:", item);
      return null;
    }

    // Return formatted link
    return {
      Name: name,
      Hash: hash,
      Size: item.Size || item.size,
      Tsize: item.Tsize,
      Type: item.Type || item.type,
    };
  } catch (error) {
    console.error("link formatting failed:", error);
    return null;
  }
}

function isIPFSDirectory(rawItem: any): boolean {
  const item = formatLink(rawItem);
  if (!item) {
    console.warn("Invalid link format:", rawItem);
    return false;
  }

  // If it has a file name with an extension, it's not a directory
  return !item.Name.includes(".");
}

// Add retry configuration for file processing
const FILE_PROCESSING_RETRIES = {
  MAX_ATTEMPTS: 3,
  INITIAL_DELAY: 1000,
  MAX_DELAY: 5000,
  BACKOFF_FACTOR: 1.5,
};

// Add helper function for file processing retries
async function withFileProcessingRetry<T>(
  operation: () => Promise<T>,
  fileName: string
): Promise<T> {
  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt < FILE_PROCESSING_RETRIES.MAX_ATTEMPTS) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      attempt++;

      if (attempt < FILE_PROCESSING_RETRIES.MAX_ATTEMPTS) {
        const delay = Math.min(
          FILE_PROCESSING_RETRIES.INITIAL_DELAY *
            Math.pow(FILE_PROCESSING_RETRIES.BACKOFF_FACTOR, attempt),
          FILE_PROCESSING_RETRIES.MAX_DELAY
        );
        console.log(`Retry ${attempt} for ${fileName}. Waiting ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw (
    lastError ||
    new Error(
      `Failed to process ${fileName} after ${FILE_PROCESSING_RETRIES.MAX_ATTEMPTS} attempts`
    )
  );
}

// Add a more robust response parsing function
async function parseDAGResponse(response: any): Promise<DAGResponse | null> {
  try {
    // If response is a string, try to parse it as JSON
    if (typeof response.data === "string") {
      // Check for common error patterns before attempting to parse
      const errorPatterns = [
        "blocked content",
        "ipfs cat",
        "error:",
        "<!doctype html",
        "<html>",
        "gateway timeout",
        "429 too many requests",
      ];

      const lowerData = response.data.toLowerCase();
      if (errorPatterns.some((pattern) => lowerData.includes(pattern))) {
        console.log(
          "Invalid response content detected:",
          lowerData.substring(0, 100)
        );
        return null;
      }

      try {
        return JSON.parse(response.data);
      } catch (e) {
        // If it's not JSON and not an error pattern, it might be raw content
        console.log("Response is not JSON, treating as raw content", response);
        return null;
      }
    }

    // If response.data is already an object, return it directly
    if (typeof response.data === "object" && response.data !== null) {
      return response.data;
    }

    return null;
  } catch (error) {
    console.error("Failed to parse DAG response:", error);
    return null;
  }
}

function sanitizeIpfsUrl(gateway: string, cid: string): string {
  // Remove any trailing slashes from gateway
  const cleanGateway = gateway.replace(/\/+$/, "");
  // Remove any leading/trailing slashes and semicolons from CID
  const cleanCid = cid.replace(/^\/+|\/+$|;+$/g, "");

  return `${cleanGateway}/ipfs/${cleanCid}`;
}

// Update the traverseDAG function to use the new gateway management
async function traverseDAG(
  cid: string,
  componentId: string,
  currentPath = "",
  visited: VisitedNodes = {},
  maxRetries = 25
): Promise<{
  visited: VisitedNodes;
  contents: IPFSContent[];
  currentPath?: string;
}> {
  const cleanCid = cid.replace(/^https:\/\/[^/]+\/ipfs\//, "");
  let attempts = 0;

  while (attempts < maxRetries) {
    const gateway = getNextAvailableGateway(gatewayStore);
    if (!gateway) {
      throw new Error("No available gateways");
    }

    console.log(
      `Attempt ${
        attempts + 1
      } of ${maxRetries} for ${cleanCid} on ${gateway} (path: ${currentPath})`
    );

    try {
      const url = sanitizeIpfsUrl(gateway, cleanCid);
      const response = await withFileProcessingRetry(async () => {
        const result = await axiosInstance.get(url, {
          headers: {
            Accept: "application/vnd.ipld.dag-json, application/json",
            "X-Content-Type-Options": "nosniff",
          },
          params: {
            format: "dag-json",
          },
          validateStatus: (status) => status >= 200 && status < 500,
          maxRedirects: 15,
          timeout: 30000,
        });

        if (!isValidGatewayResponse(result)) {
          throw new Error("Invalid gateway response");
        }

        return result;
      }, cleanCid);

      const parsedData = await parseDAGResponse(response);

      if (!parsedData) {
        // If we can't parse the response, treat it as raw content
        console.log(
          "Unable to parse response as DAG, treating as raw content",
          response
        );
        return { visited, contents: [], currentPath };
      }

      visited[cleanCid] = {
        timestamp: Date.now(),
        processed: true,
      };

      let contents: IPFSContent[] = [];

      const links = parsedData?.Objects?.[0]?.Links || parsedData?.Links || [];
      contents = links
        .map((item: any) => {
          const formattedLink = formatLink(item);
          if (!formattedLink?.Hash?.["/"]) return null;

          return {
            name: formattedLink.Name,
            hash: formattedLink.Hash["/"],
            size: formattedLink.Size || formattedLink.Tsize || 0,
            isDirectory: isIPFSDirectory(formattedLink),
          } as IPFSContent;
        })
        .filter((item): item is IPFSContent => item !== null);

      if (!currentPath) {
        const category = await determineCategory(contents);
        if (category) {
          currentPath = category;
        }
        console.log("Current path for", cleanCid, "set to:", currentPath);
      }

      // Process each item
      for (const item of contents) {
        console.log("Processing item for", cleanCid, item);
        const newPath = currentPath
          ? path.join(currentPath, item.name)
          : item.name;

        if (item.isDirectory) {
          // Skip tests directory
          if (item.name === "tests" || newPath.includes("tests")) {
            console.log(`Skipping tests directory: ${newPath}`);
            continue;
          }

          try {
            console.log(`Traversing subdirectory ${newPath}`);
            const subDirResult = await traverseDAG(
              item.hash,
              componentId,
              newPath,
              visited,
              maxRetries
            );
            item.contents = subDirResult.contents;
            visited = subDirResult.visited;
          } catch (error) {
            console.error(`Failed to read subdirectory ${newPath}:`, error);
          }
        } else if (
          item.name.endsWith(".py") ||
          item.name.endsWith(".proto") ||
          item.name.endsWith(".yaml") ||
          item.name.toLowerCase() === "readme.md"
        ) {
          const newPath = path.join(currentPath, item.name);
          console.log("Processing file for", cleanCid, item);

          const existingStatus = await executeQuery(async (client) => {
            const result = await client.query(
              `SELECT status FROM context_processing_status 
               WHERE id = $1 AND location = $2`,
              [componentId, newPath]
            );
            return result.rows[0]?.status;
          });

          // Skip if already completed successfully
          if (existingStatus === ProcessingStatus.COMPLETED) {
            console.log(`Skipping ${newPath} - already processed successfully`);
            continue;
          }

          // Update status to processing
          if (existingStatus !== ProcessingStatus.PROCESSING) {
            await updateProcessingStatus(
              componentId,
              newPath,
              ProcessingStatus.PROCESSING
            );
          }

          try {
            await withFileProcessingRetry(async () => {
              console.log("Getting file for", cleanCid, item);
              // First attempt with cache control
              let response = await axiosInstance.get(
                `${gateway}/ipfs/${item.hash}`,
                {
                  headers: getContentTypeHeaders("raw", true),
                  params: { format: "raw" },
                }
              );

              // If we get a 304 or empty response, retry without cache headers
              if (response.status === 304 || !response.data) {
                console.log("Cache miss, retrying without cache headers...");
                response = await axiosInstance.get(
                  `${gateway}/ipfs/${item.hash}`,
                  {
                    headers: getContentTypeHeaders("raw", false),
                    params: { format: "raw" },
                  }
                );
              }

              if (!response.data) {
                throw new Error(`Empty content received for ${item.hash}`);
              }

              const cleanedCodeContent =
                typeof response.data === "string"
                  ? response.data.replace(/[\r\n]/g, " ")
                  : String(response.data).replace(/[\r\n]/g, " ");

              console.log(
                `Content length for ${item.name}: ${cleanedCodeContent.length}`
              );

              const fileUrl = `${gateway}/ipfs/${item.hash}`;
              await dbQueue.add(async () => {
                try {
                  const result = await processCodeContent(
                    componentId,
                    newPath,
                    cleanedCodeContent,
                    fileUrl,
                    gateway,
                    cid
                  );
                  // Update status to completed
                  if (result) {
                    console.log(`Updated status for ${newPath} to completed`);
                    await updateProcessingStatus(
                      componentId,
                      newPath,
                      ProcessingStatus.COMPLETED
                    );
                  } else {
                    console.log(`Updated status for ${newPath} to failed`);
                    await updateProcessingStatus(
                      componentId,
                      newPath,
                      ProcessingStatus.FAILED,
                      "Failed to process code content"
                    );
                  }
                } catch (error) {
                  console.error(
                    `Failed to process code content ${newPath}:`,
                    error
                  );
                  await updateProcessingStatus(
                    componentId,
                    newPath,
                    ProcessingStatus.FAILED,
                    "Failed to process code content"
                  );
                }
              });
            }, item.name);
          } catch (error: any) {
            console.error(`Failed to process file ${newPath}:`, error);
            // Update status to failed
            await updateProcessingStatus(
              componentId,
              newPath,
              ProcessingStatus.FAILED,
              error.message
            );
          }
        }
      }

      return { visited, contents, currentPath };
    } catch (error) {
      markGatewayFailure(gatewayStore, gateway);
      attempts++;

      const delay = calculateRetryDelay(attempts);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  console.log(`DAG traversal failed for ${currentPath}/${cleanCid}`);
  return { visited, contents: [], currentPath };
}

// Add helper function for status updates
async function updateProcessingStatus(
  componentId: string,
  location: string,
  status: ProcessingStatus,
  errorMessage?: string
): Promise<void> {
  await dbQueue.add(async () => {
    await executeQuery(async (client) => {
      if (status === ProcessingStatus.COMPLETED) {
        await client.query(
          `INSERT INTO context_processing_status (
            id,
            company_id,
            type,
            location,
            name,
            status,
            error_message,
            updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
          ON CONFLICT (id, type) DO UPDATE SET
            location = EXCLUDED.location,
            name = EXCLUDED.name,
            status = EXCLUDED.status,
            error_message = EXCLUDED.error_message,
            updated_at = NOW()`,
          [
            componentId,
            "olas",
            "component",
            location,
            location,
            status,
            errorMessage || null,
          ]
        );
      } else {
        await client.query(
          `INSERT INTO context_processing_status (
            id,
            company_id,
            type,
            status,
            error_message,
            updated_at
          ) VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (id, type) DO UPDATE SET
            status = EXCLUDED.status,
            error_message = EXCLUDED.error_message,
            updated_at = NOW()`,
          [componentId, "olas", "component", status, errorMessage || null]
        );
      }
    });
  });
}
