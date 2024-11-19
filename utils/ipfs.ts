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

const IPFS_GATEWAYS = ["https://gateway.autonolas.tech"];

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
        const response = await axiosInstance.get(apiUrl, {
          timeout: 25000,
        });

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

// Add these constants at the top of the file
const MAX_TOKENS = 8000; // Slightly below the 8192 limit to provide safety margin
const TOKEN_OVERLAP = 200;

// Helper function to estimate tokens (rough approximation)
function estimateTokens(text: string): number {
  // OpenAI generally uses ~4 chars per token for English text
  return Math.ceil(text.length / 4);
}

function splitTextIntoChunks(text: string, maxTokens: number): string[] {
  const chunks: string[] = [];
  let currentChunk = "";
  const words = text.split(/\s+/);

  for (const word of words) {
    const testChunk = currentChunk + " " + word;
    if (estimateTokens(testChunk) > maxTokens) {
      chunks.push(currentChunk.trim());
      currentChunk = word;
    } else {
      currentChunk = testChunk;
    }
  }
  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

// Modified generateEmbeddingWithRetry function
export async function generateEmbeddingWithRetry(
  text: string,
  maxRetries: number = 3,
  initialDelay: number = 200
): Promise<any> {
  const estimatedTokens = estimateTokens(text);

  // If text is within token limit, proceed normally
  if (estimatedTokens <= MAX_TOKENS) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const cleanedText = text.replace(/[\r\n]/g, " ");
        const embeddingResponse = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: cleanedText,
          dimensions: 512,
        });

        return pgvector.toSql(embeddingResponse.data?.[0]?.embedding);
      } catch (error: any) {
        // If we hit the token limit, break out of retry loop and handle splitting
        if (
          error.status === 400 &&
          error.message?.includes("maximum context length")
        ) {
          break;
        }

        if (attempt === maxRetries) {
          console.error(
            "Failed all retry attempts for embedding generation:",
            error
          );
          throw error;
        }

        const delay =
          initialDelay * Math.pow(1.5, attempt - 1) + Math.random() * 100;
        console.log(
          `Embedding generation attempt ${attempt} failed. Retrying in ${delay}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // Split text into chunks
  console.log("Text too long for single embedding, splitting into chunks...");
  const chunks = splitTextIntoChunks(text, MAX_TOKENS);

  // Process each chunk
  const embeddings: any[] = [];
  for (let i = 0; i < chunks.length; i++) {
    console.log(`Processing chunk ${i + 1}/${chunks.length}`);
    try {
      const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: chunks[i] as string,
        dimensions: 512,
      });

      embeddings.push(pgvector.toSql(embeddingResponse.data?.[0]?.embedding));
    } catch (error) {
      console.error(`Failed to generate embedding for chunk ${i + 1}:`, error);
      throw error;
    }
  }

  return embeddings;
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
            client,
            componentId,
            relativePath,
            cleanedCodeContent
          );
          // On successful processing
          await client.query(
            `
          UPDATE code_processing_status 
          SET status = $1, error_message = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE component_id = $2 AND file_path = $3
        `,
            [ProcessingStatus.COMPLETED, componentId, relativePath]
          );
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
  let client = await pool.connect();
  const relativePath = path.relative(
    "./downloads",
    path.join(outputDir, fileName)
  );

  try {
    console.log(`Starting download for ${fileName}...`);

    // Simplified status tracking
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
        await client.query("BEGIN");
        const checkQuery = `SELECT * FROM code_embeddings WHERE component_id = $1 AND file_path = $2 LIMIT 1`;
        const result = await client.query(checkQuery, [
          componentId,
          outputPath,
        ]);
        console.log("Check query result:", result.rows);
        if (result.rows.length > 0) {
          console.log(`File ${fileName} already exists in the database`);
          await client.query("COMMIT");
          client.release();
          return outputPath;
        }
        const relativePath = path.relative("./downloads", outputPath);

        return await downloadWithRetry(
          attempt,
          fileName,
          outputPath,
          client,
          componentId,
          relativePath,
          response,
          maxRetries
        );
      } catch (error: any) {
        lastError = error;
        console.log(`Gateway ${gateway} failed, trying next one...`);
        continue;
      }
    }

    throw lastError || new Error("All gateways failed");
  } catch (error: any) {
    console.error(`Download failed for ${fileName}:`, error.message);
    if (client) {
      await client.query(
        `
        UPDATE code_processing_status 
        SET status = $1, error_message = $2, updated_at = CURRENT_TIMESTAMP
        WHERE component_id = $3 AND file_path = $4
      `,
        [ProcessingStatus.FAILED, error.message, componentId, relativePath]
      );
      await client.query("ROLLBACK");
      client.release();
    }
    throw error;
  } finally {
    console.log(`Cleanup for ${fileName}`);
    if (client) {
      client.release();
    }
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

// Simplified retry function
export async function retryFailedProcessing() {
  const client = await pool.connect();
  try {
    const failedFiles = await client.query(
      `
      SELECT component_id, file_path 
      FROM code_processing_status 
      WHERE status = $1 
      AND updated_at < NOW() - INTERVAL '1 hour'
      LIMIT 100
    `,
      [ProcessingStatus.FAILED]
    );

    for (const row of failedFiles.rows) {
      try {
        await recursiveDownload(row.component_id, 3, row.component_id);
      } catch (error) {
        console.error(`Failed to reprocess ${row.file_path}:`, error);
      }
    }
  } finally {
    client.release();
  }
}

// Add this helper function to handle file chunk naming
function getChunkFileName(
  originalPath: string,
  chunkIndex: number,
  totalChunks: number
): string {
  if (totalChunks <= 1) return originalPath;

  const parsedPath = path.parse(originalPath);
  return path.format({
    dir: parsedPath.dir,
    name: `${parsedPath.name}.part${chunkIndex + 1}of${totalChunks}`,
    ext: parsedPath.ext,
  });
}

// Update the processCodeContent function
async function processCodeContent(
  client: PoolClient,
  componentId: string,
  relativePath: string,
  cleanedCodeContent: string
): Promise<void> {
  // Generate embeddings (might return single or multiple embeddings)
  const embeddings = await generateEmbeddingWithRetry(cleanedCodeContent);

  // Handle single or multiple embeddings
  if (!Array.isArray(embeddings[0])) {
    // Single embedding case - store as normal
    const mainInsertQuery = `
      INSERT INTO code_embeddings (
        component_id,
        file_path,
        code_content,
        embedding
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (component_id, file_path) 
      DO UPDATE SET
        code_content = EXCLUDED.code_content,
        embedding = EXCLUDED.embedding
      RETURNING id;
    `;

    await client.query(mainInsertQuery, [
      componentId,
      relativePath,
      cleanedCodeContent,
      embeddings,
    ]);
  } else {
    // Multiple embeddings case - store chunks with modified file paths
    const chunks = splitTextIntoChunks(cleanedCodeContent, MAX_TOKENS);

    for (let i = 0; i < embeddings.length; i++) {
      const chunkPath = getChunkFileName(relativePath, i, embeddings.length);

      const chunkInsertQuery = `
        INSERT INTO code_embeddings (
          component_id,
          file_path,
          code_content,
          embedding,
          is_chunk,
          original_file_path
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (component_id, file_path) 
        DO UPDATE SET
          code_content = EXCLUDED.code_content,
          embedding = EXCLUDED.embedding
      `;

      await client.query(chunkInsertQuery, [
        componentId,
        chunkPath,
        chunks[i],
        embeddings[i],
        true,
        relativePath,
      ]);
    }
  }
}
