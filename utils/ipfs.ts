import axios, { AxiosInstance, AxiosResponse } from "axios";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";

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

async function downloadIPFSFile(
  ipfsHash: string,
  fileName: string,
  outputDir: string = "./downloads"
): Promise<string> {
  try {
    console.log("Original hash:", ipfsHash);
    // First decode any HTML entities, then properly encode for URL
    const decodedHash = decodeURIComponent(ipfsHash);
    console.log("Decoded hash:", decodedHash);
    const encodedHash = encodeURIComponent(decodedHash)
      .replace(/%2F/g, "/") // preserve forward slashes
      .replace(/%20/g, "+") // replace spaces with plus signs
      .replace(/…/g, ""); // remove ellipsis characters

    console.log("Encoded hash:", encodedHash);
    const fileUrl = `https://gateway.autonolas.tech/ipfs/${encodedHash}`;
    console.log(`File URL: ${fileUrl}`);
    await fs.mkdir(outputDir, { recursive: true });

    console.log(`Downloading file: ${fileName}`, fileUrl);
    // Sanitize the fileName to remove or replace invalid characters
    const sanitizedFileName = fileName.replace(/[<>:"/\\|?*]/g, "_");
    const outputPath = path.join(outputDir, sanitizedFileName);

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

      writer.on("finish", () => {
        if (receivedData) {
          console.log(`Downloaded ${fileName} successfully to ${outputPath}`);
          resolve(outputPath);
        } else {
          fsSync.unlink(outputPath, () => {});
          reject(new Error("No data received"));
        }
      });

      writer.on("error", (err) => {
        fsSync.unlink(outputPath, () => {});
        reject(err);
      });

      response.data.pipe(writer);
    });
  } catch (error: any) {
    console.error(`Error downloading file ${fileName}:`, error.message);
    throw error;
  }
}

async function determineDirectoryType(contents: any) {
  // Check if specific files exist in the contents
  const files = contents.map((item: any) => item.name);
  if (files.includes("service.yaml")) return "services";
  if (files.includes("aea-config.yaml")) return "agents";
  return "connections";
}

async function processIPFSItem(
  item: any,
  currentPath = "",
  retryAttempts = 10
) {
  try {
    if (item.isDirectory) {
      // Get contents of this directory first
      const dirUrl = `https://gateway.autonolas.tech/ipfs/${item.hash}`;
      const contents = await readIPFSDirectory(dirUrl);

      // Determine the type of directory
      const dirType = await determineDirectoryType(contents);

      // Create the new path including the directory type
      const typePath = currentPath === "" ? dirType : currentPath;
      const newPath = path.join(typePath, item.name);
      const outputDir = path.join("./downloads", newPath);

      console.log(`Entering directory: ${newPath} (Type: ${dirType})`);
      await fs.mkdir(outputDir, { recursive: true });

      // Process all contents
      for (const content of contents) {
        await processIPFSItem(content, newPath, retryAttempts);
      }
    } else {
      // Check if this is a service.yaml or aea-config.yaml file
      if (item.name === "service.yaml") {
        const outputDir = path.join("./downloads", currentPath);
        const filePath = path.join(outputDir, item.name);

        // First download the service.yaml file
        await downloadIPFSFile(item.hash, item.name, outputDir);

        // Then process it to find and download agent dependencies
        await extractAndDownloadFromServiceYaml(filePath);
      } else if (item.name === "aea-config.yaml") {
        const outputDir = path.join("./downloads", currentPath);
        const filePath = path.join(outputDir, item.name);

        // First download the aea-config.yaml file
        await downloadIPFSFile(item.hash, item.name, outputDir);

        // Then process it to find and download dependencies
        await extractAndDownloadAgentDependencies(filePath);
      } else {
        // Handle other files as before
        const outputDir = path.join("./downloads", currentPath);
        await downloadIPFSFile(item.hash, item.name, outputDir);
      }
    }
  } catch (error: any) {
    console.error(`Error processing item ${item.name}:`, error.message);
    throw error;
  }
}

async function extractAndDownloadFromServiceYaml(filePath: string) {
  try {
    const content = await fs.readFile(filePath, "utf8");

    // First, find and process the agent dependency
    const agentMatch = content.match(/agent:.*?:([a-z0-9]{59})/i);

    if (agentMatch && agentMatch[1]) {
      const agentHash = agentMatch[1];
      console.log(`Found agent IPFS hash in service.yaml: ${agentHash}`);

      // Create agent directory
      const agentDir = path.join(path.dirname(filePath), "agent_dependencies");
      await fs.mkdir(agentDir, { recursive: true });

      // Read the agent directory contents
      const contents = await readIPFSDirectory(agentHash);
      console.log(`Found ${contents.length} items in agent directory`);

      // Process each item with the agent_dependencies path
      for (const item of contents) {
        await processIPFSItem(item, path.relative("./downloads", agentDir));
      }

      // Now look for agent's dependencies in the downloaded agent files
      const agentFiles = await fs.readdir(agentDir, { recursive: true });
      for (const file of agentFiles) {
        if (file.endsWith("aea-config.yaml")) {
          const agentConfigPath = path.join(agentDir, file);
          await extractAndDownloadAgentDependencies(agentConfigPath);
        }
      }
    }
  } catch (error) {
    console.error("Error processing service.yaml:", error);
    throw error;
  }
}

async function extractAndDownloadAgentDependencies(agentConfigPath: string) {
  try {
    const content = await fs.readFile(agentConfigPath, "utf8");

    // Helper function to extract hashes from YAML list items
    const extractHashesFromList = (content: string) => {
      // Match pattern: - valory/name:version:hash
      const pattern = /- .*?:.*?:([a-z0-9]{59})/g;
      const matches = [...content.matchAll(pattern)];
      return matches.map((match) => match[1]);
    };
    console.log(`Extracting hashes from list: ${content}`);

    // Define sections to look for
    const sections = {
      connections: /connections:\n((?:- .*?\n)*)/,
      contracts: /contracts:\n((?:- .*?\n)*)/,
      protocols: /protocols:\n((?:- .*?\n)*)/,
      skills: /skills:\n((?:- .*?\n)*)/,
    };

    // Process each section
    for (const [type, pattern] of Object.entries(sections)) {
      const sectionMatch = content.match(pattern);
      if (sectionMatch && sectionMatch[1]) {
        const sectionContent = sectionMatch[1];
        const hashes = extractHashesFromList(sectionContent);

        for (const hash of hashes) {
          if (!hash) continue;
          console.log(`Found ${type} hash: ${hash}`);

          // Create type-specific subdirectory
          const dependencyDir = path.join(path.dirname(agentConfigPath), type);
          await fs.mkdir(dependencyDir, { recursive: true });

          await recursiveDownload(hash);
        }
      }
    }
  } catch (error) {
    console.error("Error processing agent dependencies:", error);
    throw error;
  }
}

// Track downloaded hashes to prevent duplicates
const downloadedHashes = new Set();

async function recursiveDownload(ipfsHash: string, retryAttempts = 3) {
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
      await processIPFSItem(item, "", retryAttempts);
    }

    console.log(`Completed download for hash: ${ipfsHash}`);
  } catch (error) {
    console.error(`Failed to download ${ipfsHash}:`, error);
    throw error;
  }
}
