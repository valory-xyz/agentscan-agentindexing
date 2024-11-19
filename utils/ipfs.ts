import axios, { AxiosInstance, AxiosResponse } from "axios";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import {
  generateEmbeddingWithRetry,
  MAX_TOKENS,
  splitTextIntoChunks,
} from "./openai";
import { executeQuery } from "./postgres";

import { PoolClient } from "pg";
import pQueue from "p-queue";

// Configure axios defaults
const axiosInstance = axios.create({
  timeout: 20000,
  maxRedirects: 3,
  validateStatus: (status) => status >= 200 && status < 500,
});

const IPFS_GATEWAYS = [
  "https://gateway.autonolas.tech",
  "https://ipfs.io",
  "https://gateway.pinata.cloud",
];

let currentGatewayIndex = 0;

function getNextGateway(): string | undefined {
  if (IPFS_GATEWAYS.length === 0) {
    throw new Error("No IPFS gateways configured");
  }
  const gateway = IPFS_GATEWAYS[currentGatewayIndex];

  currentGatewayIndex = (currentGatewayIndex + 1) % IPFS_GATEWAYS.length;
  return gateway;
}

async function readIPFSDirectory(cid: string, maxRetries: number = 25) {
  const cleanCid = cid.replace(/^https:\/\/[^/]+\/ipfs\//, "");
  let attempts = 0;
  let lastError;

  while (attempts < maxRetries) {
    const gateway = getNextGateway();
    console.log(
      `Attempt ${attempts + 1} of ${maxRetries} for ${cleanCid} on ${gateway}`
    );
    try {
      if (!gateway) {
        throw new Error("No available gateways");
      }

      const apiUrl = `${gateway}/api/v0/ls?arg=${cleanCid}`;
      const response = await axiosInstance.get(apiUrl);

      if (response.data?.Objects?.[0]?.Links) {
        return response.data.Objects[0].Links.map((item: any) => ({
          name: item.Name,
          hash: item.Hash,
          size: item.Size,
          isDirectory: item.Type === 1 || item.Type === "dir",
        }));
      }

      // If Objects is missing, treat as an error and retry
      console.log(`No Objects found in response, retrying...`, apiUrl);
      const delay = Math.min(1000 * Math.pow(1.5, attempts - 1), 4000);
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempts++;
      continue;
    } catch (error: any) {
      lastError = error;
      console.log(
        `Gateway ${gateway} failed, attempt ${attempts}/${maxRetries}`
      );
      const delay = Math.min(1000 * Math.pow(1.5, attempts - 1), 5000);
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempts++;
      continue;
    }
  }
  throw lastError || new Error("No valid Objects found after all retries");
}

// Simplify the status enum
enum ProcessingStatus {
  PROCESSING = "processing",
  COMPLETED = "completed",
  FAILED = "failed",
}

const downloadWithRetry = async (
  attempt = 1,
  fileName: string,
  outputPath: string,
  client: PoolClient,
  componentId: string,
  relativePath: string,
  response: AxiosResponse,
  maxRetries: number = 15
): Promise<any> => {
  return new Promise((resolve, reject) => {
    console.log(`Creating write stream for ${fileName}`);
    const writer = fsSync.createWriteStream(outputPath);
    let receivedData = false;
    let dataSize = 0;
    let timeoutId: NodeJS.Timeout;

    // Set a timeout for the entire operation
    const operationTimeout = setTimeout(() => {
      console.log(`Operation timed out for ${fileName}`);
      writer.end();
      reject(new Error("Operation timeout"));
    }, 30000); // 30 second total timeout

    response.data.on("data", (chunk: any) => {
      dataSize += chunk.length;
      receivedData = true;
      console.log(`Received chunk for ${fileName}: ${dataSize} bytes`);

      // Reset the timeout on each chunk
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        console.log(`Data transfer stalled for ${fileName}`);
        writer.end();
        reject(new Error("Data transfer timeout"));
      }, 10000); // 10 second timeout between chunks
    });

    writer.on("finish", async () => {
      console.log(`Write stream finished for ${fileName}`);
      clearTimeout(timeoutId);
      clearTimeout(operationTimeout);

      if (!receivedData) {
        console.log(`No data received for ${fileName}`);
        reject(new Error("No data received"));
        return;
      }

      try {
        console.log(`Reading file content for ${fileName}`);
        const codeContent = await fs.readFile(outputPath, "utf-8");
        console.log(`Successfully read file content for ${fileName}`);

        if (!codeContent) {
          throw new Error("Invalid code content");
        }

        const cleanedCodeContent = codeContent.replace(/[\r\n]/g, " ");

        // Add check for blocked content
        if (cleanedCodeContent.includes("Blocked content")) {
          console.log("Blocked content detected, retrying download...");
          await fs.unlink(outputPath).catch(console.error);
          if (attempt < maxRetries) {
            console.log(
              `Initiating retry attempt ${attempt + 1}/${maxRetries}`
            );
            const result = await downloadWithRetry(
              attempt + 1,
              fileName,
              outputPath,
              client,
              componentId,
              relativePath,
              response,
              maxRetries
            );
            resolve(result);
            return;
          } else {
            reject(
              new Error(
                "Failed to download after all retries - Blocked content"
              )
            );
            return;
          }
        }
        try {
          await processCodeContent(
            componentId,
            relativePath,
            cleanedCodeContent
          );
          // On successful processing
          await executeQuery(async (client) => {
            await client.query(
              `
          UPDATE code_processing_status 
          SET status = $1, error_message = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE component_id = $2 AND file_path = $3
        `,
              [ProcessingStatus.COMPLETED, componentId, relativePath]
            );
          });
        } catch (error) {
          console.error(`Error processing ${fileName}:`, error);
          throw error;
        }

        console.log(`Database operations completed for ${fileName}`);
        resolve(outputPath);
      } catch (error) {
        console.error(`Error processing ${fileName}:`, error);

        reject(error);
      }
    });

    writer.on("error", (err) => {
      console.error(`Write stream error for ${fileName}:`, err);
      clearTimeout(timeoutId);
      clearTimeout(operationTimeout);
      reject(err);
    });

    console.log(`Starting pipe operation for ${fileName}`);
    response.data.pipe(writer);
  });
};

async function downloadIPFSFile(
  ipfsHash: string,
  fileName: string,
  outputDir: string = "./downloads",
  componentId: string,
  maxRetries: number = 15
): Promise<string | null> {
  return await executeQuery(async (client) => {
    const fullPath = path.join(outputDir, fileName);
    const relativePath = fileName;

    console.log(`Starting download for ${relativePath}...`);

    try {
      const checkResult = await executeQuery(async (client) => {
        return await client.query(
          `SELECT * FROM code_embeddings WHERE component_id = $1 AND file_path = $2 LIMIT 1`,
          [componentId, relativePath]
        );
      });

      if (checkResult.rows.length > 0) {
        console.log(`File ${relativePath} already exists in the database`);
        return fullPath;
      }

      await executeQuery(async (client) => {
        await client.query(
          `
          INSERT INTO code_processing_status (component_id, file_path, status)
          VALUES ($1, $2, $3)
          ON CONFLICT (component_id, file_path) 
          DO UPDATE SET 
            status = $3,
            updated_at = CURRENT_TIMESTAMP
        `,
          [componentId, relativePath, ProcessingStatus.PROCESSING]
        );
      });

      let lastError;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const gateway = getNextGateway();
        const fileUrl = `${gateway}/ipfs/${encodeURIComponent(ipfsHash)}`;

        try {
          const response = await axiosInstance({
            method: "get",
            url: fileUrl,
            responseType: "stream",
          });

          await fs.mkdir(outputDir, { recursive: true });
          const sanitizedFileName = fileName.replace(/[<>:"/\\|?*]/g, "_");
          const outputPath = path.join(outputDir, sanitizedFileName);

          // Process the download
          const result = await new Promise((resolve, reject) => {
            const writer = fsSync.createWriteStream(outputPath);
            let receivedData = false;
            let dataSize = 0;

            response.data.on("data", (chunk: any) => {
              dataSize += chunk.length;
              receivedData = true;
            });

            writer.on("finish", async () => {
              if (!receivedData) {
                reject(new Error("No data received"));
                return;
              }

              try {
                const codeContent = await fs.readFile(outputPath, "utf-8");
                if (!codeContent) {
                  throw new Error("Invalid code content");
                }

                const cleanedCodeContent = codeContent.replace(/[\r\n]/g, " ");

                if (cleanedCodeContent.includes("Blocked content")) {
                  reject(new Error("Blocked content detected"));
                  return;
                }

                // Process the code content within the same transaction
                await processCodeContent(
                  componentId,
                  relativePath,
                  cleanedCodeContent
                );

                // Update status to completed
                await executeQuery(async (client) => {
                  await client.query(
                    `
                  UPDATE code_processing_status 
                  SET status = $1, error_message = NULL, updated_at = CURRENT_TIMESTAMP
                  WHERE component_id = $2 AND file_path = $3
                `,
                    [ProcessingStatus.COMPLETED, componentId, relativePath]
                  );
                });

                resolve(outputPath);
              } catch (error) {
                reject(error);
              }
            });

            writer.on("error", reject);
            response.data.pipe(writer);
          });

          // If we get here, everything succeeded
          await client.query("COMMIT");
          return result as string;
        } catch (error: any) {
          lastError = error;
          console.log(`Gateway ${gateway} failed, trying next one...`);

          // Only rollback if there's a database-related error
          if (
            error.message.includes("database") ||
            error.message.includes("sql")
          ) {
            await client.query("ROLLBACK");
            throw error; // Re-throw database errors immediately
          }

          continue; // Continue to next gateway for non-database errors
        }
      }

      // If we get here, all gateways failed
      await client.query("ROLLBACK");
      throw lastError || new Error("All gateways failed");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
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
export const dbQueue = new pQueue({ concurrency: 5 }); // Limit concurrent DB operations

// Update processIPFSItem to use queue
async function processIPFSItem(
  item: any,
  currentPath = "",
  retryAttempts = 25,
  componentId: string
) {
  try {
    if (item.isDirectory) {
      const dirUrl = `https://gateway.autonolas.tech/ipfs/${item.hash}`;

      // Add fallback for readIPFSDirectory
      let contents;
      try {
        contents = await readIPFSDirectory(dirUrl);
      } catch (error) {
        console.error(`Failed to read IPFS directory ${dirUrl}:`, error);
        // Fallback: treat as empty directory and continue
        contents = [];
      }

      // Add fallback for determineCategory
      let category;
      try {
        category = await determineCategory(contents);
      } catch (error) {
        console.error(`Failed to determine category for ${dirUrl}:`, error);
        // Fallback: use a default category or derive from path
        category = currentPath.split("/")[0] || "unknown";
      }

      let newPath;
      if (category) {
        newPath = currentPath
          ? path.join(currentPath, item.name)
          : path.join(category, item.name);
      } else {
        newPath = currentPath ? path.join(currentPath, item.name) : item.name;
      }

      const outputDir = path.join("./downloads", newPath);
      console.log(`Processing directory: ${newPath}`);

      try {
        await fs.mkdir(outputDir, { recursive: true });
      } catch (error) {
        console.error(`Failed to create directory ${outputDir}:`, error);
        // Continue execution even if directory creation fails
      }

      // Process contents with individual error handling
      for (const content of contents) {
        try {
          console.log(`Processing item ${content.name} for ${newPath}`);
          await processIPFSItem(content, newPath, retryAttempts, componentId);
        } catch (error) {
          console.error(`Failed to process item ${content.name}:`, error);
          // Continue with next item instead of failing completely
          continue;
        }
      }
    } else {
      if (
        item.name.endsWith(".py") ||
        item.name.endsWith(".proto") ||
        item.name.toLowerCase() === "readme.md"
      ) {
        const outputDir = path.join("./downloads", currentPath);

        // Queue the database operation
        await dbQueue.add(async () => {
          return executeQuery(async (client) => {
            await client.query("BEGIN");
            try {
              await downloadIPFSFile(
                item.hash,
                item.name,
                outputDir,
                componentId
              );
              await client.query("COMMIT");
            } catch (error) {
              await client.query("ROLLBACK");
              throw error;
            }
          });
        });
      }
    }
  } catch (error: any) {
    console.log(
      `Error processing item ${item?.name || "unknown"}:`,
      error.message
    );
    return null;
  }
}

// Add a helper function for safe error handling
async function safeDownload(
  ipfsHash: string,
  componentId: string
): Promise<void> {
  try {
    console.log(`Starting safe download for hash: ${ipfsHash}`);

    // First, update status to processing

    // Create downloads directory
    await fs.mkdir("./downloads", { recursive: true }).catch((err) => {
      console.warn("Directory creation warning:", err);
    });

    // Try to read directory with better error handling
    let contents;
    try {
      contents = await readIPFSDirectory(ipfsHash);
      console.log(`Found ${contents?.length || 0} items in root directory`);
    } catch (error) {
      console.error(`Failed to read IPFS directory ${ipfsHash}:`, error);

      return;
    }

    if (!contents || !Array.isArray(contents)) {
      console.error("Invalid contents returned from IPFS");
      return;
    }

    // Process each item with individual error handling
    for (const item of contents) {
      try {
        await processIPFSItem(item, "", 3, componentId);
      } catch (error) {
        console.error(
          `Failed to process item ${item?.name || "unknown"}:`,
          error
        );
        // Continue with next item instead of failing completely
      }
    }
  } catch (error) {
    console.error(`Safe download failed for ${ipfsHash}:`, error);
  } finally {
    // Cleanup with error handling
    try {
      await fs.rm("./downloads", { recursive: true, force: true });
      console.log("Cleaned up downloads directory");
    } catch (cleanupError) {
      console.warn("Cleanup warning:", cleanupError);
    }
  }
}

// Replace the existing recursiveDownload function
export async function recursiveDownload(
  ipfsHash: string,
  retryAttempts = 3,
  componentId: string
): Promise<void> {
  await safeDownload(ipfsHash, componentId);
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

  const parsedPath = path.parse(originalPath);
  const directory = parsedPath.dir;
  const newName = `${parsedPath.name}.part${chunkIndex + 1}of${totalChunks}`;

  return path.join(directory, newName + parsedPath.ext);
}

// Update processCodeContent to use queue
async function processCodeContent(
  componentId: string,
  relativePath: string,
  cleanedCodeContent: string
): Promise<void> {
  return dbQueue.add(async () => {
    const embeddings = await generateEmbeddingWithRetry(cleanedCodeContent);

    if (!Array.isArray(embeddings) || embeddings.length === 1) {
      console.log("Processing as single embedding");
      // Single embedding case - store as normal
      const mainInsertQuery = `
        INSERT INTO code_embeddings (
          component_id,
          file_path,
          code_content,
          embedding,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, NOW(), NOW())
        ON CONFLICT (component_id, file_path) 
        DO UPDATE SET
          code_content = EXCLUDED.code_content,
          embedding = EXCLUDED.embedding,
          updated_at = NOW()
      `;

      await executeQuery(async (client) => {
        await client.query(mainInsertQuery, [
          componentId,
          relativePath,
          cleanedCodeContent,
          embeddings,
        ]);
      });
    } else {
      console.log("Processing as multiple embeddings");

      // Multiple embeddings case
      const chunks = splitTextIntoChunks(cleanedCodeContent, MAX_TOKENS);

      for (let i = 0; i < embeddings.length; i++) {
        const chunkPath = getChunkFileName(relativePath, i, embeddings.length);
        console.log(
          `Processing chunk ${i + 1} of ${embeddings.length}: ${chunkPath}`
        );
        const chunkInsertQuery = `
          INSERT INTO code_embeddings (
            component_id,
            file_path,
            code_content,
            embedding,
            is_chunk,
            original_file_path,
            created_at,
            updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
          ON CONFLICT (component_id, file_path) 
          DO UPDATE SET
            code_content = EXCLUDED.code_content,
            embedding = EXCLUDED.embedding,
            updated_at = NOW()
          RETURNING component_id, file_path
        `;

        const query = await executeQuery(async (client) => {
          return await client.query(chunkInsertQuery, [
            componentId,
            chunkPath,
            chunks[i],
            embeddings[i],
            true,
            relativePath,
          ]);
        });
        console.log(
          `Chunk inserted ${i + 1} of ${embeddings.length}:`,
          query.rows
        );
      }
    }
  });
}
