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

async function readIPFSDirectory(cid: string, maxRetries: number = 20) {
  try {
    // Extract just the CID from the full URL if a URL is passed
    console.log(`CID: ${cid}`);
    const cleanCid = cid.replace(/^https:\/\/[^/]+\/ipfs\//, "");

    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const gateway = getNextGateway();
      console.log(`Gateway: ${gateway}`);
      const apiUrl = `${gateway}/api/v0/ls?arg=${cleanCid}`;

      try {
        console.log(`Attempting with gateway: ${gateway}`);
        const response = await axiosInstance.get(apiUrl);

        if (response.data && response.data.Objects) {
          const contents = response.data.Objects[0].Links.map((item: any) => ({
            name: item.Name,
            hash: item.Hash,
            size: item.Size,
            isDirectory: item.Type === 1 || item.Type === "dir",
          }));

          return contents;
        }

        return [];
      } catch (error: any) {
        lastError = error;
        console.log(`Gateway ${gateway} failed, trying next one...`);
        continue;
      }
    }

    // If we've exhausted all retries
    console.error("Failed to read directory after all retries");
    throw lastError;
  } catch (error: any) {
    console.error("Error reading IPFS directory:", error.message);
    throw error;
  }
}

export async function generateEmbeddingWithRetry(
  text: string,
  maxRetries: number = 3,
  initialDelay: number = 400
): Promise<number[] | undefined> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: text,
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
        initialDelay * Math.pow(2, attempt - 1) + Math.random() * 200;
      console.log(
        `Embedding generation attempt ${attempt} failed. Retrying in ${delay}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error("Failed to generate embedding after all retries");
}

async function downloadIPFSFile(
  ipfsHash: string,
  fileName: string,
  outputDir: string = "./downloads",
  componentId: string,
  maxRetries: number = 3
): Promise<string | null> {
  let client: PoolClient | undefined;

  try {
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
                console.log("Download failed");
              }
            }, 20000); // 20 second timeout

            response.data.on("data", () => {
              console.log("Received data");
              receivedData = true;
            });

            writer.on("finish", async () => {
              clearTimeout(timeoutId);
              try {
                if (receivedData) {
                  const codeContent = await fs.readFile(outputPath, "utf-8");
                  if (!codeContent) {
                    console.error("No code content received");
                    await fs.unlink(outputPath);
                    return resolve(outputPath);
                  }
                  console.log("Code content received");

                  const embedding = await generateEmbeddingWithRetry(
                    codeContent
                  );
                  console.log("Embedding received", embedding);
                  if (!embedding) {
                    console.error("No embedding received");
                    await fs.unlink(outputPath);
                    return resolve(outputPath);
                  }

                  // Get a new client connection if needed
                  if (!client) {
                    client = await pool.connect();
                  }

                  try {
                    await client.query("BEGIN");
                    console.log("Starting database transaction");

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

                    const result = await client.query(insertQuery, [
                      componentId,
                      relativePath,
                      embedding,
                      codeContent,
                    ]);

                    console.log("Insert query parameters:", {
                      componentId,
                      relativePath,
                      embeddingLength: embedding.length,
                      contentLength: codeContent.length,
                    });

                    await client.query("COMMIT");
                    console.log("Database transaction committed successfully");
                  } catch (dbError) {
                    console.error("Database error:", dbError);
                    await client.query("ROLLBACK");
                    throw dbError;
                  }

                  await fs.unlink(outputPath);
                  return resolve(outputPath);
                }
              } catch (error) {
                console.error("Error in writer finish handler:", error);
                if (client) {
                  await client.query("ROLLBACK").catch(console.error);
                }
                reject(error);
              } finally {
                if (client) {
                  client.release();
                }
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
      await client.query("ROLLBACK").catch(console.error);
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
  retryAttempts = 10,
  componentId: string
) {
  try {
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
      // Only download .py and .proto files
      if (item.name.endsWith(".py") || item.name.endsWith(".proto")) {
        const outputDir = path.join("./downloads", currentPath);
        await downloadIPFSFile(item.hash, item.name, outputDir, componentId);
      }
    }
  } catch (error: any) {
    console.log(`Error processing item ${item.name}:`, error.message);
    return null;
  }
}

// Track downloaded hashes to prevent duplicates
const downloadedHashes = new Set();

export async function recursiveDownload(
  ipfsHash: string,
  retryAttempts = 3,
  componentId: string
) {
  try {
    if (downloadedHashes.has(ipfsHash)) {
      console.log(`Skipping already downloaded hash: ${ipfsHash}`);
      return;
    }

    console.log(`Starting recursive download from hash: ${ipfsHash}`);
    downloadedHashes.add(ipfsHash);

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

    // Delete the downloads directory and all its contents
    await fs.rm("./downloads", { recursive: true, force: true });
    console.log("Cleaned up downloads directory");
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
