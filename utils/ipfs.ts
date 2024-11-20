import axios from "axios";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import {
  generateEmbeddingWithRetry,
  MAX_TOKENS,
  splitTextIntoChunks,
} from "./openai";
import { executeQuery } from "./postgres";
import pQueue from "p-queue";

// Configure axios defaults
const axiosInstance = axios.create({
  timeout: 30000,
  maxRedirects: 15,
  validateStatus: (status) => status >= 200 && status < 500,
});

const IPFS_GATEWAYS = [
  "https://gateway.autonolas.tech",
  "https://ipfs.io",
  "https://dweb.link",
];

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
  PROCESSING = "processing",
  COMPLETED = "completed",
  FAILED = "failed",
}

// Add retry delay configuration
const RETRY_DELAYS = {
  MIN_DELAY: 1000, // 1 second
  MAX_DELAY: 30000, // 30 seconds
  MULTIPLIER: 1.5,
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

// Add a helper function for safe error handling
async function safeDownload(
  ipfsHash: string,
  componentId: string,
  retryAttempts = 15,
  attempts = 0
): Promise<void> {
  try {
    console.log(`Starting safe download for hash: ${ipfsHash}`);

    await fs.mkdir("./downloads", { recursive: true }).catch((err) => {
      console.warn("Directory creation warning:", err);
    });

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
      // // Update status to failed
      // await executeQuery(async (client) => {
      //   await client.query(
      //     `UPDATE code_processing_status SET status = $1, error_message = $2 WHERE component_id = $3`,
      //     [
      //       ProcessingStatus.FAILED,
      //       `DAG traversal failed: ${error.message}`,
      //       componentId,
      //     ]
      //   );
      // });
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
    return await safeDownload(ipfsHash, componentId, retryAttempts);
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
): Promise<void> {
  try {
    const embeddings = await generateEmbeddingWithRetry(cleanedCodeContent);
    console.log("Embeddings:", embeddings);

    if (!Array.isArray(embeddings) || embeddings.length === 1) {
      await safeQueueOperation(async () => {
        await dbQueue.add(
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
        ); // Add timeout per operation
      });
    } else {
      const chunks = splitTextIntoChunks(cleanedCodeContent, MAX_TOKENS);

      // Process chunks in parallel with individual error handling
      await Promise.allSettled(
        chunks.map((chunk, i) =>
          safeQueueOperation(async () => {
            const chunkPath = getChunkFileName(
              relativePath,
              i,
              embeddings.length
            );
            await dbQueue.add(
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
            ); // Add timeout per operation
          })
        )
      );
    }
  } catch (error) {
    console.error(`Failed to process code content for ${relativePath}:`, error);
  }
}

// Add helper function for content type negotiation
function getContentTypeHeaders(format?: string) {
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

  return {
    Accept: format ? formatMap[format] : "application/vnd.ipld.raw",
    "Cache-Control": "only-if-cached",
    "If-None-Match": "*",
  };
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
    console.error("Error formatting link:", error);
    return null;
  }
}

function isIPFSDirectory(rawItem: any): boolean {
  const item = formatLink(rawItem);
  if (!item) {
    console.warn("Invalid link format:", rawItem);
    return false;
  }

  // Check for Tsize property (common in directory entries)
  if (item.Tsize !== undefined) {
    return true;
  }

  // Now we can safely check other properties
  if (item.Name.endsWith("/")) {
    return true;
  }

  // Check for directory-like sizes
  if (item.Size === 0 || item.Size === 2 || item.Size === 4) {
    return true;
  }

  // Check for Qm prefix with small size
  const hashValue = Object.values(item.Hash)[0];
  if (hashValue?.startsWith("Qm") && (item.Size || 0) < 100) {
    return true;
  }

  return false;
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

  // Check if already visited recently (within last hour)
  if (
    visited[cleanCid] &&
    visited[cleanCid].processed &&
    Date.now() - visited[cleanCid].timestamp < 3600000
  ) {
    return { visited, contents: [], currentPath };
  }

  while (attempts < maxRetries) {
    const gateway = getNextGateway();
    console.log(
      `Attempt ${
        attempts + 1
      } of ${maxRetries} for ${cleanCid} on ${gateway} (path: ${currentPath})`
    );

    try {
      const response = await axiosInstance.get(`${gateway}/ipfs/${cleanCid}`, {
        headers: {
          Accept: "application/vnd.ipld.dag-json, application/json",
          "X-Content-Type-Options": "nosniff",
        },
        params: {
          format: "dag-json",
        },
      });

      if (
        typeof response.data === "string" &&
        (response.data.includes("Blocked content") ||
          response.data.includes("ipfs cat") ||
          response.data.includes("Error:") ||
          response.data.includes("<!DOCTYPE html>") ||
          response.data.includes("<html>") ||
          response.data.toLowerCase().includes("<!doctype html>"))
      ) {
        throw new Error("Invalid response format from gateway");
      }

      let parsedData;
      try {
        parsedData =
          typeof response.data === "string"
            ? JSON.parse(response.data)
            : response.data;
      } catch (e: any) {
        console.log("Failed to parse DAG response:", e);
        throw new Error(`Invalid DAG response format: ${e.message}`);
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
        console.log("Contents for", cleanCid, ":", contents);

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
            item.name.toLowerCase() === "readme.md"
          ) {
            console.log("Processing file", item.hash, "at", newPath);
            console.log("url:", `${gateway}/ipfs/${item.hash}`);
            // Process file content and generate embeddings
            try {
              await dbQueue.add(async () => {
                const response = await axiosInstance.get(
                  `${gateway}/ipfs/${item.hash}`,
                  {
                    headers: getContentTypeHeaders("raw"),
                    params: { format: "raw" },
                  }
                );

                const codeContent = response.data;
                const cleanedCodeContent = codeContent.replace(/[\r\n]/g, " ");

                // Create the directory if it doesn't exist
                const outputDir = path.join("./downloads", currentPath);
                await fs.mkdir(outputDir, { recursive: true });

                // Write the file
                const sanitizedFileName = item.name.replace(
                  /[<>:"/\\|?*]/g,
                  "_"
                );
                const outputPath = path.join(outputDir, sanitizedFileName);
                await fs.writeFile(outputPath, codeContent);

                // Process the content for embeddings
                await processCodeContent(
                  componentId,
                  path.join(currentPath, item.name),
                  cleanedCodeContent
                );
              });
            } catch (error) {
              console.error(`Failed to process file ${newPath}:`, error);
            }
          }
        }
      }

      return { visited, contents, currentPath };
    } catch (error) {
      console.log(
        `Error traversing DAG node ${currentPath}/${cleanCid}:`,
        error
      );
      attempts++;

      // Add exponential backoff delay
      const delay = calculateRetryDelay(attempts);
      console.log(`Waiting ${delay}ms before retry...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return { visited, contents: [], currentPath };
}
