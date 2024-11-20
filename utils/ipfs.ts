import axios from "axios";
import path from "path";
import {
  generateEmbeddingWithRetry,
  MAX_TOKENS,
  splitTextIntoChunks,
} from "./openai";
import { executeQuery } from "./postgres";
import pQueue from "p-queue";

const axiosInstance = axios.create({
  timeout: 30000,
  maxRedirects: 15,
  validateStatus: (status) => status >= 200 && status < 500,
});

const IPFS_GATEWAYS = ["https://gateway.autonolas.tech", "https://ipfs.io"];

let currentGatewayIndex = 0;

function getNextGateway(): string {
  if (IPFS_GATEWAYS.length === 0) {
    throw new Error("No IPFS gateways configured");
  }
  const gateway = IPFS_GATEWAYS[currentGatewayIndex];
  currentGatewayIndex = (currentGatewayIndex + 1) % IPFS_GATEWAYS.length;
  return gateway as string;
}

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

// Create a queue for database operations
export const dbQueue = new pQueue({
  concurrency: 5,
  timeout: 60000, // 1 minute timeout
  throwOnTimeout: true,
}).on("error", async (error) => {
  console.log(`Database operation failed: ${error.message}`);
});

// Add error boundary wrapper for queue operations
async function safeQueueOperation<T>(
  operation: () => Promise<T>
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    console.error("Queue operation failed:", error);
    return null;
  }
}

// Add new helper function for component status updates
async function updateComponentStatus(
  componentId: string,
  status: ProcessingStatus,
  errorMessage?: string
): Promise<void> {
  await dbQueue.add(async () => {
    await executeQuery(async (client) => {
      await client.query(
        `INSERT INTO component_processing_status (
          component_id,
          status,
          error_message,
          updated_at
        ) VALUES ($1, $2, $3, NOW())
        ON CONFLICT (component_id) DO UPDATE SET
          status = EXCLUDED.status,
          error_message = EXCLUDED.error_message,
          updated_at = NOW()`,
        [componentId, status, errorMessage || null]
      );
    });
  });
}

// Add new helper function to check if component is already processed
async function isComponentCompleted(componentId: string): Promise<boolean> {
  const result = await dbQueue.add(async () => {
    return await executeQuery(async (client) => {
      const response = await client.query(
        `SELECT status 
         FROM component_processing_status 
         WHERE component_id = $1 
         AND status = $2`,
        [componentId, ProcessingStatus.COMPLETED]
      );
      return response.rows.length > 0;
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

// Replace the existing recursiveDownload function
export async function recursiveDownload(
  ipfsHash: string,
  retryAttempts = 15,
  componentId: string
): Promise<void> {
  try {
    // Check if component is already completed
    const isCompleted = await isComponentCompleted(componentId);
    if (isCompleted) {
      console.log(`Component ${componentId} already processed, skipping`);
      return;
    }
    await updateComponentStatus(componentId, ProcessingStatus.PROCESSING);
    await safeDownload(ipfsHash, componentId, retryAttempts);
    await updateComponentStatus(componentId, ProcessingStatus.COMPLETED);
    return;
  } catch (error) {
    console.error(`Failed to download ${ipfsHash}:`, error);
    await updateComponentStatus(componentId, ProcessingStatus.FAILED);
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

// Add this helper function to handle file chunk naming
function getChunkFileName(
  originalPath: string,
  chunkIndex: number,
  totalChunks: number
): string {
  if (totalChunks <= 1) return originalPath;

  const cleanPath = originalPath.replace(/^downloads\//, "");
  const parsedPath = path.parse(cleanPath);
  const directory = parsedPath.dir;
  const newName = `${parsedPath.name}.part${chunkIndex + 1}of${totalChunks}`;

  return path.join(directory, newName + parsedPath.ext);
}

// Update processCodeContent to use safer queue operations
async function processCodeContent(
  componentId: string,
  relativePath: string,
  cleanedCodeContent: string
): Promise<boolean> {
  try {
    const embeddings = await generateEmbeddingWithRetry(cleanedCodeContent);

    if (!Array.isArray(embeddings) || embeddings.length === 1) {
      const result = await safeQueueOperation(async () => {
        return await dbQueue.add(
          async () => {
            await executeQuery(async (client) => {
              await client.query(
                `INSERT INTO code_embeddings (
                component_id,
                file_path,
                code_content,
                embedding,
                created_at,
                updated_at
              ) VALUES ($1, $2, $3, $4, NOW(), NOW())
               ON CONFLICT (component_id, file_path) DO UPDATE SET
                 code_content = EXCLUDED.code_content,
                 embedding = EXCLUDED.embedding,
                 updated_at = NOW()
              RETURNING component_id, file_path`,
                [componentId, relativePath, cleanedCodeContent, embeddings]
              );
            });
          },
          { timeout: 30000 }
        );
      });
      return result !== null;
    } else {
      const chunks = splitTextIntoChunks(cleanedCodeContent, MAX_TOKENS);
      const results = await Promise.allSettled(
        chunks.map((chunk, i) =>
          safeQueueOperation(async () => {
            const chunkPath = getChunkFileName(
              relativePath,
              i,
              embeddings.length
            );
            return await dbQueue.add(
              async () => {
                await executeQuery(async (client) => {
                  await client.query(
                    `INSERT INTO code_embeddings (
                    component_id,
                    file_path,
                    code_content,
                    embedding,
                    is_chunk,
                    original_file_path,
                    created_at,
                    updated_at
                  ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
                   ON CONFLICT (component_id, file_path) DO UPDATE SET
                     code_content = EXCLUDED.code_content,
                     embedding = EXCLUDED.embedding,
                     updated_at = NOW()
                  RETURNING component_id, file_path`,
                    [
                      componentId,
                      chunkPath,
                      chunk,
                      embeddings[i],
                      true,
                      relativePath,
                    ]
                  );
                });
              },
              { timeout: 30000 }
            );
          })
        )
      );

      // Check if all chunks were processed successfully
      return results.every(
        (result) => result.status === "fulfilled" && result.value !== null
      );
    }
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
    const gateway = getNextGateway();
    console.log(
      `Attempt ${
        attempts + 1
      } of ${maxRetries} for ${cleanCid} on ${gateway} (path: ${currentPath})`
    );

    try {
      //add file processing retry
      const response = await withFileProcessingRetry(async () => {
        return await axiosInstance.get(`${gateway}/ipfs/${cleanCid}`, {
          headers: {
            Accept: "application/vnd.ipld.dag-json, application/json",
            "X-Content-Type-Options": "nosniff",
          },
          params: {
            format: "dag-json",
          },
        });
      }, cleanCid);

      if (
        typeof response.data === "string" &&
        (response.data.includes("Blocked content") ||
          response.data.includes("ipfs cat") ||
          response.data.includes("Error:") ||
          response.data.includes("<!DOCTYPE html>") ||
          response.data.includes("<html>") ||
          response.data.toLowerCase().includes("<!doctype html>"))
      ) {
        throw new Error(
          "failed to retrieve correct response format from gateway"
        );
      }

      let parsedData;
      try {
        // Check if the response is markdown or plain text content
        if (
          typeof response.data === "string" &&
          (response.data.startsWith("#") ||
            response.data.startsWith("```") ||
            response.data.includes("<!DOCTYPE html>") ||
            response.data.includes("<html>"))
        ) {
          // Handle as raw content instead of trying to parse as JSON
          return { visited, contents: [], currentPath };
        }

        parsedData =
          typeof response.data === "string"
            ? JSON.parse(response.data)
            : response.data;
      } catch (e: any) {
        // If parsing fails, treat it as raw content
        console.log("Failed to parse DAG response, treating as raw content");
        return { visited, contents: [], currentPath };
      }

      // Mark as visited with timestamp
      visited[cleanCid] = {
        timestamp: Date.now(),
        processed: true,
      };

      let contents: IPFSContent[] = [];

      // Process directory contents (either format)
      if (parsedData?.Objects?.[0]?.Links || parsedData?.Links) {
        const links = parsedData?.Objects?.[0]?.Links || parsedData?.Links;
        contents = links.map((item: any) => ({
          name: item.Name,
          hash: item.Hash["/"],
          size: item.Size || item.Tsize,
          isDirectory: isIPFSDirectory(item),
        }));

        // Determine category for root level
        if (!currentPath) {
          const category = await determineCategory(contents);
          if (category) {
            currentPath = category;
          }
          console.log("Current path for", cleanCid, "set to:", currentPath);
        }

        // Process each item
        for (const item of contents) {
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

            // Check existing status
            const existingStatus = await executeQuery(async (client) => {
              const result = await client.query(
                `SELECT status FROM code_processing_status 
                 WHERE component_id = $1 AND file_path = $2`,
                [componentId, newPath]
              );
              return result.rows[0]?.status;
            });

            // Skip if already completed successfully
            if (existingStatus === ProcessingStatus.COMPLETED) {
              console.log(
                `Skipping ${newPath} - already processed successfully`
              );
              continue;
            }

            // Update status to processing
            await updateProcessingStatus(
              componentId,
              newPath,
              ProcessingStatus.PROCESSING
            );

            try {
              await withFileProcessingRetry(async () => {
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

                const codeContent = response.data;

                if (!codeContent) {
                  throw new Error(`Empty content received for ${item.hash}`);
                }

                const cleanedCodeContent =
                  typeof codeContent === "string"
                    ? codeContent.replace(/[\r\n]/g, " ")
                    : String(codeContent).replace(/[\r\n]/g, " ");

                console.log(
                  `Content length for ${item.name}: ${cleanedCodeContent.length}`
                );

                await dbQueue.add(async () => {
                  try {
                    const result = await processCodeContent(
                      componentId,
                      newPath,
                      cleanedCodeContent
                    );
                    // Update status to completed
                    if (result) {
                      await updateProcessingStatus(
                        componentId,
                        newPath,
                        ProcessingStatus.COMPLETED
                      );
                    } else {
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
      }

      return { visited, contents, currentPath };
    } catch (error) {
      attempts++;

      // Add exponential backoff delay
      const delay = calculateRetryDelay(attempts);
      console.log(`Waiting ${delay}ms before retry...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  console.log(`DAG traversal failed for ${currentPath}/${cleanCid}`);
  return { visited, contents: [], currentPath };
}

// Add helper function for status updates
async function updateProcessingStatus(
  componentId: string,
  filePath: string,
  status: ProcessingStatus,
  errorMessage?: string
): Promise<void> {
  await dbQueue.add(async () => {
    await executeQuery(async (client) => {
      await client.query(
        `INSERT INTO code_processing_status (
          component_id,
          file_path,
          status,
          error_message,
          updated_at
        ) VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (component_id, file_path) DO UPDATE SET
          status = EXCLUDED.status,
          error_message = EXCLUDED.error_message,
          updated_at = NOW()`,
        [componentId, filePath, status, errorMessage || null]
      );
    });
  });
}
