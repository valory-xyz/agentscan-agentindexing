import axios, { AxiosInstance, AxiosResponse } from "axios";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import openai from "./openai";
import pool from "./postgres";
import pgvector from "pgvector";
import { PoolClient } from "pg";

// Configure axios defaults
const axiosInstance = axios.create({
  timeout: 20000,
  maxRedirects: 3,
  validateStatus: (status) => status >= 200 && status < 500, // More specific status validat
});

const IPFS_GATEWAYS = [
  "https://gateway.autonolas.tech",
  "https://ipfs.io",
  "https://flk-ipfs.xyz",
  "https://dweb.link",
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
  try {
    const cleanCid = cid.replace(/^https:\/\/[^/]+\/ipfs\//, "");
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const gateway = getNextGateway();
      const apiUrl = `${gateway}/api/v0/ls?arg=${cleanCid}`;

      try {
        console.log(
          `Attempt ${attempt}/${maxRetries} with gateway: ${gateway}`
        );
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
        console.log(`No Objects found in response, retrying...`);
        const delay = Math.min(1000 * Math.pow(1.5, attempt - 1), 4000);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      } catch (error: any) {
        lastError = error;
        console.log(
          `Gateway ${gateway} failed, attempt ${attempt}/${maxRetries}`
        );
        const delay = Math.min(1000 * Math.pow(1.5, attempt - 1), 5000);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
    }
    throw lastError || new Error("No valid Objects found after all retries");
  } catch (error: any) {
    console.error("Error reading IPFS directory:", error.message);
    throw error;
  }
}

export async function generateEmbeddingWithRetry(
  text: string,
  maxRetries: number = 3,
  initialDelay: number = 200
): Promise<number[] | undefined> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      //clean the text, remove newlines and carriage returns
      const cleanedText = text.replace(/[\r\n]/g, " ");
      const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: cleanedText,
        dimensions: 512,
      });

      return pgvector.toSql(embeddingResponse.data?.[0]?.embedding);
    } catch (error: any) {
      if (attempt === maxRetries) {
        console.error(
          "Failed all retry attempts for embedding generation:",
          error
        );
        throw error;
      }

      // Calculate delay with exponential backoff and jitter
      const delay =
        initialDelay * Math.pow(1.5, attempt - 1) + Math.random() * 100;
      console.log(
        `Embedding generation attempt ${attempt} failed. Retrying in ${delay}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error("Failed to generate embedding after all retries");
}

// Add new status tracking enum
enum ProcessingStatus {
  PENDING = "pending",
  PROCESSING = "processing",
  COMPLETED = "completed",
  FAILED = "failed",
}

async function downloadIPFSFile(
  ipfsHash: string,
  fileName: string,
  outputDir: string = "./downloads",
  componentId: string,
  maxRetries: number = 3
): Promise<string | null> {
  let client: PoolClient | undefined;
  let relativePath: string = path.relative(
    "./downloads",
    path.join(outputDir, fileName)
  );

  try {
    // Initialize status tracking
    client = await pool.connect();
    await client.query("BEGIN");

    // Update or insert processing status
    const statusQuery = `
      INSERT INTO code_processing_status (component_id, file_path, status)
      VALUES ($1, $2, $3)
      ON CONFLICT (component_id, file_path) 
      DO UPDATE SET 
        status = $3,
        retry_count = code_processing_status.retry_count + 1,
        last_attempted_at = CURRENT_TIMESTAMP
      RETURNING retry_count;
    `;

    const statusResult = await client.query(statusQuery, [
      componentId,
      relativePath,
      ProcessingStatus.PROCESSING,
    ]);

    const retryCount = statusResult.rows[0]?.retry_count || 0;
    if (retryCount >= maxRetries) {
      throw new Error(`Max retries (${maxRetries}) exceeded for ${fileName}`);
    }

    console.log("Original hash:", ipfsHash);
    console.log("Starting download process for:", fileName);

    const decodedHash = decodeURIComponent(ipfsHash);
    console.log("Decoded hash:", decodedHash);

    const encodedHash = encodeURIComponent(decodedHash)
      .replace(/%2F/g, "/")
      .replace(/%20/g, "+")
      .replace(/…/g, "");
    console.log("Encoded hash:", encodedHash);

    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const gateway = getNextGateway();
      const fileUrl = `${gateway}/ipfs/${encodedHash}`;
      console.log(`Gateway: ${gateway}`);
      console.log(`Attempting download from ${fileUrl}`);

      try {
        const response = await axiosInstance({
          method: "get",
          url: fileUrl,
          responseType: "stream",
        });

        await fs.mkdir(outputDir, { recursive: true });
        const sanitizedFileName = fileName.replace(/[<>:"/\\|?*]/g, "_");
        const outputPath = path.join(outputDir, sanitizedFileName);
        //check if the file already is in the database
        client = await pool.connect();
        await client.query("BEGIN");
        const checkQuery = `SELECT * FROM code_embeddings WHERE component_id = $1 AND file_path = $2 LIMIT 1`;
        const result = await client.query(checkQuery, [
          componentId,
          outputPath,
        ]);
        console.log("Check query result:", result.rows);
        if (result.rows.length > 0) {
          console.log(`File ${fileName} already exists in the database`);
          client.release();
          return outputPath;
        }
        const relativePath = path.relative("./downloads", outputPath);

        const downloadWithRetry = async (attempt = 1): Promise<any> => {
          return new Promise((resolve, reject) => {
            const writer = fsSync.createWriteStream(outputPath);
            let receivedData = false;
            let timeoutId: NodeJS.Timeout;

            // Set a timeout for the download
            timeoutId = setTimeout(async () => {
              console.log(
                `Download timed out for ${fileName} after 20 seconds`
              );
              writer.end();
              await fs.unlink(outputPath).catch(console.error);

              if (attempt < maxRetries) {
                console.log(
                  `Retrying download attempt ${attempt + 1}/${maxRetries}`
                );
                const result = await downloadWithRetry(attempt + 1);
                console.log("Download result:", result);
                resolve(result);
              } else {
                reject(
                  new Error(`Failed to download after ${maxRetries} attempts`)
                );
              }
            }, 20000); // 20 second timeout

            response.data.on("data", () => {
              console.log("Received data");
              receivedData = true;
            });

            writer.on("finish", async () => {
              clearTimeout(timeoutId);
              if (!client) {
                throw new Error("Database client is not initialized");
              }
              try {
                if (receivedData) {
                  const codeContent = await fs.readFile(outputPath, "utf-8");

                  if (!codeContent) {
                    throw new Error("Invalid code content");
                  }

                  const cleanedCodeContent = codeContent.replace(
                    /[\r\n]/g,
                    " "
                  );

                  const embedding = await generateEmbeddingWithRetry(
                    cleanedCodeContent
                  );

                  if (!embedding) {
                    throw new Error("Invalid embedding generated");
                  }

                  // Update database
                  const insertQuery = `
                    INSERT INTO code_embeddings (
                      component_id,
                      file_path,
                      embedding,
                      code_content
                    ) VALUES ($1, $2, $3, $4)
                    ON CONFLICT (component_id, file_path) 
                    DO UPDATE SET
                      embedding = EXCLUDED.embedding,
                      code_content = EXCLUDED.code_content
                    RETURNING *;
                  `;

                  await client.query(insertQuery, [
                    componentId,
                    relativePath,
                    embedding,
                    cleanedCodeContent,
                  ]);

                  // Update status to completed
                  await client.query(
                    `UPDATE code_processing_status 
                     SET status = $1, error_message = NULL 
                     WHERE component_id = $2 AND file_path = $3`,
                    [ProcessingStatus.COMPLETED, componentId, relativePath]
                  );

                  await client.query("COMMIT");
                }
              } catch (error: any) {
                await client.query(
                  `UPDATE code_processing_status 
                   SET status = $1, error_message = $2 
                   WHERE component_id = $3 AND file_path = $4`,
                  [
                    ProcessingStatus.FAILED,
                    error.message,
                    componentId,
                    relativePath,
                  ]
                );
                await client.query("ROLLBACK");
                throw error;
              }
            });

            writer.on("error", async (err) => {
              clearTimeout(timeoutId);
              console.log("Write stream error:", err);
              await fs.unlink(outputPath).catch(console.error);
              reject(err);
            });

            response.data.pipe(writer);
          });
        };

        return await downloadWithRetry();
      } catch (error: any) {
        lastError = error;
        console.log(`Gateway ${gateway} failed, trying next one...`);
        continue;
      }
    }

    throw lastError || new Error("All gateways failed");
  } catch (error: any) {
    console.error("Download failed:", error.message);
    if (client) {
      await client.query(
        `UPDATE code_processing_status 
         SET status = $1, error_message = $2 
         WHERE component_id = $3 AND file_path = $4`,
        [ProcessingStatus.FAILED, error.message, componentId, relativePath]
      );
      await client.query("ROLLBACK");
      client.release();
    }
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

async function processIPFSItem(
  item: any,
  currentPath = "",
  retryAttempts = 25,
  componentId: string
) {
  try {
    console.log("Processing item:", item.name);
    // Add check for tests folder
    if (item.name === "tests" || currentPath.includes("tests")) {
      console.log("Skipping tests folder");
      return;
    }

    if (item.isDirectory) {
      // Get contents of this directory
      const dirUrl = `https://gateway.autonolas.tech/ipfs/${item.hash}`;
      const contents = await readIPFSDirectory(dirUrl);

      // Determine category from YAML files
      const category = await determineCategory(contents);

      console.log("Category:", category);
      // Create the new path, including category if found
      let newPath;
      if (category) {
        newPath = path.join(category, item.name);
      } else {
        newPath = currentPath ? path.join(currentPath, item.name) : item.name;
      }

      const outputDir = path.join("./downloads", newPath);

      console.log(`Entering directory: ${newPath}`);
      await fs.mkdir(outputDir, { recursive: true });

      // Recursively process directory contents
      for (const content of contents) {
        await processIPFSItem(content, newPath, retryAttempts, componentId);
      }
    } else {
      // Update file extension check to include README.md
      if (
        item.name.endsWith(".py") ||
        item.name.endsWith(".proto") ||
        item.name.toLowerCase() === "readme.md"
      ) {
        const outputDir = path.join("./downloads", currentPath);
        console.log("Downloading file:", item.name);
        await downloadIPFSFile(item.hash, item.name, outputDir, componentId);
      } else {
        console.log("Skipping non-supported file:", item.name);
      }
    }
  } catch (error: any) {
    console.log(`Error processing item ${item.name}:`, error.message);
    return null;
  }
}

export async function recursiveDownload(
  ipfsHash: string,
  retryAttempts = 3,
  componentId: string
) {
  try {
    console.log(`Starting recursive download from hash: ${ipfsHash}`);

    // Create base downloads directory
    await fs.mkdir("./downloads", { recursive: true });

    // Read root directory
    const contents = await readIPFSDirectory(ipfsHash);
    console.log(`Found ${contents.length} items in root directory`);

    // Process each item
    for (const item of contents) {
      await processIPFSItem(item, "", retryAttempts, componentId);
    }

    console.log(`Completed download for hash: ${ipfsHash}`);
  } catch (error) {
    console.error(`Failed to download ${ipfsHash}:`, error);
    await fs
      .rm("./downloads", { recursive: true, force: true })
      .catch((error) =>
        console.error("Failed to clean up downloads directory:", error)
      );
    throw error;
  } finally {
    // Ensure cleanup happens whether there's an error or not
    try {
      await fs.rm("./downloads", { recursive: true, force: true });
      console.log("Cleaned up downloads directory");
    } catch (cleanupError) {
      console.error("Failed to clean up downloads directory:", cleanupError);
    }
  }
}

// Add a new function to retry failed processes
export async function retryFailedProcessing() {
  const client = await pool.connect();
  try {
    const failedQuery = `
      SELECT component_id, file_path 
      FROM code_processing_status 
      WHERE status = $1 AND retry_count < $2
      AND (last_attempted_at IS NULL OR last_attempted_at < NOW() - INTERVAL '1 hour')
    `;

    const failedResults = await client.query(failedQuery, [
      ProcessingStatus.FAILED,
      3,
    ]);

    for (const row of failedResults.rows) {
      try {
        // Reprocess the file
        await recursiveDownload(row.component_id, 3, row.component_id);
      } catch (error) {
        console.error(`Failed to reprocess ${row.file_path}:`, error);
      }
    }
  } finally {
    client.release();
  }
}
