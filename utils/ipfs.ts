import axios, { AxiosInstance, AxiosResponse } from "axios";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import openai from "./openai";
import pool from "./postgres";
import pgvector from "pgvector";

// Configure axios defaults
const axiosInstance = axios.create({
  timeout: 30000,
  maxRedirects: 5,
  validateStatus: (status) => status < 400,
});

async function readIPFSDirectory(cid: string, maxRetries: number = 20) {
  try {
    // Extract just the CID from the full URL if a URL is passed
    console.log(`CID: ${cid}`);
    const cleanCid = cid.replace("https://gateway.autonolas.tech/ipfs/", "");

    // Using the IPFS HTTP API
    const apiUrl = `https://gateway.autonolas.tech/api/v0/ls?arg=${cleanCid}`;
    console.log(`API URL: ${apiUrl}`);

    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
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
        if (error.response?.status === 404) {
          console.log(`Attempt ${attempt}/${maxRetries}: Got 404, retrying...`);

          // Exponential backoff with jitter
          const baseDelay = Math.min(1000 * Math.pow(2, attempt), 10000);
          const jitter = Math.random() * 1000;
          const delay = baseDelay + jitter;

          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw error; // If it's not a 404, throw immediately
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

async function generateEmbeddingWithRetry(
  text: string,
  maxRetries: number = 3,
  initialDelay: number = 1000
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
        initialDelay * Math.pow(2, attempt - 1) + Math.random() * 1000;
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
  componentId: string
): Promise<string> {
  try {
    console.log("Original hash:", ipfsHash);
    const decodedHash = decodeURIComponent(ipfsHash);
    const encodedHash = encodeURIComponent(decodedHash)
      .replace(/%2F/g, "/")
      .replace(/%20/g, "+")
      .replace(/…/g, "");

    const fileUrl = `https://gateway.autonolas.tech/ipfs/${encodedHash}`;
    await fs.mkdir(outputDir, { recursive: true });

    const sanitizedFileName = fileName.replace(/[<>:"/\\|?*]/g, "_");
    const outputPath = path.join(outputDir, sanitizedFileName);
    const relativePath = path.relative("./downloads", outputPath);

    const response = await axiosInstance({
      method: "get",
      url: fileUrl,
      responseType: "stream",
    });

    return new Promise((resolve, reject) => {
      const writer = fsSync.createWriteStream(outputPath);
      let receivedData = false;

      response.data.on("data", () => {
        receivedData = true;
      });

      writer.on("finish", async () => {
        if (receivedData) {
          try {
            // Read the file content
            const codeContent = await fs.readFile(outputPath, "utf-8");
            console.log("codeContent", codeContent);

            // Generate embedding using retry function
            if (!codeContent) {
              console.error("No code content received");
              //continue
              resolve(outputPath);
            }
            const embedding = await generateEmbeddingWithRetry(codeContent);
            console.log("embedding", embedding);
            if (!embedding) {
              console.error("No embedding received");
              //continue
              resolve(outputPath);
            }

            // Start a transaction
            const client = await pool.connect();
            try {
              await client.query("BEGIN");

              // Store in PostgreSQL with pgvector
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
                  code_content = EXCLUDED.code_content;
              `;

              await client.query(insertQuery, [
                componentId,
                relativePath,
                embedding,
                codeContent,
              ]);

              // Reindex the table
              const reindexQuery = `
                REINDEX INDEX code_embeddings_embedding_idx;
              `;
              await client.query(reindexQuery);

              await client.query("COMMIT");

              console.log(
                `Processed, stored, and reindexed embedding for ${fileName}`
              );
              resolve(outputPath);
            } catch (error) {
              await client.query("ROLLBACK");
              console.error("Error processing embedding:", error);
              //continue
              resolve(outputPath);
            } finally {
              console.log("Releasing client");
              client.release();
            }

            // Delete the file after successful processing
            await fs.unlink(outputPath);
            console.log(`Deleted file: ${outputPath}`);

            resolve(outputPath);
          } catch (error) {
            console.error("Error processing embedding:", error);
            // Delete the file even if processing failed
            await fs
              .unlink(outputPath)
              .catch((err) =>
                console.error(`Error deleting file ${outputPath}:`, err)
              );
            resolve(outputPath);
          }
        } else {
          fsSync.unlink(outputPath, () => {});
          resolve(outputPath);
        }
      });

      writer.on("error", (err) => {
        fsSync.unlink(outputPath, () => {});
        resolve(outputPath);
      });

      response.data.pipe(writer);
    });
  } catch (error: any) {
    console.error(`Error downloading file ${fileName}:`, error.message);
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
    console.error(`Error processing item ${item.name}:`, error.message);
    throw error;
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
    // Attempt to clean up downloads directory even if there was an error
    try {
      await fs.rm("./downloads", { recursive: true, force: true });
      console.log("Cleaned up downloads directory after error");
    } catch (cleanupError) {
      console.error("Failed to clean up downloads directory:", cleanupError);
    }
    throw error;
  }
}
