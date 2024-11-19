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
  timeout: 20000,
  maxRedirects: 15,
  validateStatus: (status) => status >= 200 && status < 500,
});

const IPFS_GATEWAYS = ["https://gateway.autonolas.tech", "https://ipfs.io"];

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

      // Use /ls endpoint with caching headers
      const lsUrl = `${gateway}/api/v0/ls?arg=${cleanCid}`;
      const response = await axiosInstance.get(lsUrl, {
        headers: {
          Accept: "*/*",
          "Cache-Control": "only-if-cached",
          "If-None-Match": "*",
        },
        params: {
          filename: `${cleanCid}.json`,
        },
      });

      if (response.data?.Objects?.[0]?.Links) {
        console.log(
          `Found ${response.data.Objects[0].Links.length} items in /ls response`
        );
        return response.data.Objects[0].Links.map((item: any) => ({
          name: item.Name,
          hash: item.Hash,
          size: item.Size,
          type: item.Type,
          isDirectory: item.Type === 1 || item.Type === "dir",
        }));
      }

      console.log(
        `No valid directory structure found in /ls response, retrying...`
      );
      const delay = Math.min(2000 * Math.pow(2, attempts - 1), 30000);
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempts++;
      continue;
    } catch (error: any) {
      lastError = error;
      console.log(
        `Gateway ${gateway} failed, attempt ${attempts}/${maxRetries}:`,
        error.message
      );
      const delay = Math.min(2000 * Math.pow(2, attempts - 1), 30000);
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempts++;
    }
  }
  throw (
    lastError ||
    new Error("No valid directory structure found after all retries")
  );
}

// Simplify the status enum
enum ProcessingStatus {
  PROCESSING = "processing",
  COMPLETED = "completed",
  FAILED = "failed",
}

async function downloadIPFSFile(
  ipfsHash: string,
  fileName: string,
  outputDir: string = "./downloads",
  componentId: string,
  maxRetries: number = 15
): Promise<string | null> {
  const fullPath = path.join(outputDir, fileName);
  const relativePath = path.relative("downloads", fullPath);

  console.log(`Starting download for ${relativePath}...`);

  try {
    // Check if already processed
    const checkResult = await executeQuery(async (client) => {
      return await client.query(
        `SELECT * FROM code_embeddings WHERE component_id = $1 AND file_path = $2 LIMIT 1`,
        [componentId, relativePath]
      );
    });
    console.log(`Check result: ${checkResult.rows}`);

    if (checkResult.rows.length > 0) {
      console.log(`File ${relativePath} already exists in the database`);
      return fullPath;
    }

    // Set initial processing status
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
    console.log(`Set processing status for ${relativePath}`);

    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const gateway = getNextGateway();
      if (!gateway) throw new Error("No available gateways");

      try {
        // Use /cat endpoint with caching headers
        const apiUrl = `${gateway}/api/v0/cat?arg=${encodeURIComponent(
          ipfsHash
        )}`;
        const response = await axiosInstance({
          method: "get",
          url: apiUrl,
          responseType: "text",
          headers: {
            Accept: "*/*",
            "Cache-Control": "only-if-cached",
            "If-None-Match": "*",
          },
          params: {
            filename: fileName,
          },
        });

        if (!response.data) {
          throw new Error("No data received");
        }

        const codeContent = response.data;
        console.log(`Cat response: ${codeContent}`);
        const cleanedCodeContent = codeContent.replace(/[\r\n]/g, " ");

        if (cleanedCodeContent.includes("Blocked content")) {
          console.log(`Blocked content detected`);
          throw new Error("Blocked content detected");
        }

        // Ensure directory exists
        await fs.mkdir(outputDir, { recursive: true });

        // Write file to disk
        const sanitizedFileName = fileName.replace(/[<>:"/\\|?*]/g, "_");
        const outputPath = path.join(outputDir, sanitizedFileName);
        await fs.writeFile(outputPath, codeContent);
        console.log(`Wrote file to ${outputPath}`);
        // Process the content
        await processCodeContent(componentId, relativePath, cleanedCodeContent);
        console.log(`Processed code content for ${relativePath}`);
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
        console.log(`Updated status to completed for ${relativePath}`);
        return outputPath;
      } catch (error: any) {
        lastError = error;
        console.log(
          `Gateway ${gateway} failed (attempt ${attempt}/${maxRetries}):`,
          error.message
        );

        if (
          error.message.includes("database") ||
          error.message.includes("sql")
        ) {
          throw error; // Re-throw database errors immediately
        }

        // Exponential backoff
        const delay = Math.min(3000 * Math.pow(2, attempt - 1), 30000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError || new Error("All gateways failed");
  } catch (error) {
    // Update status to failed
    await executeQuery(async (client) => {
      await client.query(
        `
        UPDATE code_processing_status 
        SET status = $1, error_message = $2, updated_at = CURRENT_TIMESTAMP
        WHERE component_id = $3 AND file_path = $4
      `,
        [ProcessingStatus.FAILED, error.message, componentId, relativePath]
      );
    });
    throw error;
  }
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
      // Add check for tests directory
      if (item.name === "tests" || currentPath.includes("tests")) {
        console.log("Skipping tests directory");
        return;
      }

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
        dbQueue.add(async () => {
          try {
            await downloadIPFSFile(
              item.hash,
              item.name,
              outputDir,
              componentId,
              15
            );
          } catch (error) {
            throw error;
          }
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
  componentId: string,
  retryAttempts = 15
): Promise<void> {
  try {
    console.log(`Starting safe download for hash: ${ipfsHash}`);

    // First, update status to processing

    // Create downloads directory
    await fs.mkdir("./downloads", { recursive: true }).catch((err) => {
      console.warn("Directory creation warning:", err);
    });

    // Try to read directory with better error handling
    let contents = [];
    try {
      contents = await readIPFSDirectory(ipfsHash, retryAttempts);
      console.log(`Found ${contents?.length || 0} items in root directory`);
    } catch (error) {
      console.error(`Failed to read IPFS directory ${ipfsHash}:`, error);
    }

    if (!contents || !Array.isArray(contents)) {
      //update code_processing_status to failed
      await executeQuery(async (client) => {
        await client.query(
          `UPDATE code_processing_status SET status = $1, error_message = $2 WHERE component_id = $3`,
          [
            ProcessingStatus.FAILED,
            "Failed to read IPFS directory",
            componentId,
          ]
        );
      });
    }

    // Process each item with individual error handling
    for (const item of contents) {
      try {
        await processIPFSItem(item, "", retryAttempts, componentId);
      } catch (error) {
        console.error(
          `Failed to process item ${item?.name || "unknown"}:`,
          error
        );
      }
    }
  } catch (error) {
    console.error(`Safe download failed for ${ipfsHash}:`, error);
  }
}

// Replace the existing recursiveDownload function
export async function recursiveDownload(
  ipfsHash: string,
  retryAttempts = 15,
  componentId: string
): Promise<void> {
  return await safeDownload(ipfsHash, componentId, retryAttempts);
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

// Update processCodeContent to use queue
async function processCodeContent(
  componentId: string,
  relativePath: string,
  cleanedCodeContent: string
): Promise<void> {
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
    return dbQueue.add(async () => {
      await executeQuery(async (client) => {
        await client.query(mainInsertQuery, [
          componentId,
          relativePath,
          cleanedCodeContent,
          embeddings,
        ]);
      });
      console.log(`Inserted ${relativePath}`);
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
      return dbQueue.add(async () => {
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
      });
    }
  }
}
