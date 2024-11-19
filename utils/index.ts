import axios from "axios";
import { recursiveDownload } from "./ipfs";
import pool, { executeQuery } from "./postgres";

import { generateEmbeddingWithRetry } from "./openai";
import { dbQueue } from "./ipfs";

// Helper function to get chain name from contract name
export const getChainName = (contractName: string) => {
  return contractName
    .replace("Registry", "")
    .replace("Staking", "")
    .toLowerCase();
};

// Helper to create unique IDs across chains
export const createChainScopedId = (
  chain: string,
  serviceId: string
): string => {
  // First, clean up the serviceId by removing any existing prefixes
  const cleanId = serviceId
    .replace(/^service-/g, "") // Remove any leading 'service-'
    .replace(new RegExp(`^${chain}-`, "i"), ""); // Remove any leading 'chainname-'

  return `${chain}-${cleanId}`;
};

// List all contract names
export const CONTRACT_NAMES = [
  "MainnetStaking",
  "PolygonRegistry",
  "GnosisRegistry",
  "ArbitrumRegistry",
  "OptimismRegistry",
  "BaseRegistry",
  // "CeloRegistry",
  // "ModeRegistry",
] as const;

// Helper to get chainId from chain name
export const getChainId = (chain: string): number => {
  switch (chain.toLowerCase()) {
    case "mainnet":
      return 1;
    case "polygon":
      return 137;
    case "gnosis":
      return 100;
    case "arbitrum":
      return 42161;
    case "optimism":
      return 10;
    case "base":
      return 8453;
    default:
      return 1; // Default to mainnet
  }
};

// Add delay helper function
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const fetchAndEmbedMetadata = async (
  configHash: string,
  maxRetries = 3,
  componentId: string
) => {
  // Create config info object for component type
  const configInfo = {
    type: "component",
    id: componentId,
  };

  const metadata = await fetchAndTransformMetadata(
    configHash,
    maxRetries,
    configInfo
  );

  if (metadata?.packageHash) {
    console.log("Downloading package hash...", metadata.packageHash);
    try {
      void recursiveDownload(metadata.packageHash, 3, componentId);
    } catch (error) {
      console.error("Error downloading package hash:", error);
    }
  } else {
    console.log("No package hash found", componentId);
  }

  return metadata;
};

// Add this new helper function
export const fetchAndTransformMetadata = async (
  configHash: string,
  maxRetries = 3,
  configInfo: any
) => {
  const metadataPrefix = "f01701220";
  const finishedConfigHash = configHash.slice(2);
  const ipfsURL = "https://gateway.autonolas.tech/ipfs/";
  const metadataURI = `${ipfsURL}${metadataPrefix}${finishedConfigHash}`;

  // Implement retry logic
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const metadata = await axios.get(metadataURI, {
        timeout: 3500, // 4 seconds timeout
      });
      let metadataJson = metadata.data;

      // Handle package hash extraction first
      if (metadataJson.code_uri) {
        // Try different possible formats
        if (metadataJson.code_uri.includes("ipfs://")) {
          metadataJson.packageHash = metadataJson.code_uri.split("ipfs://")[1];
        } else if (metadataJson.code_uri.includes("/ipfs/")) {
          metadataJson.packageHash = metadataJson.code_uri.split("/ipfs/")[1];
        } else {
          // If code_uri exists but doesn't match expected formats
          metadataJson.packageHash = metadataJson.code_uri;
        }

        // Clean up any trailing slashes or whitespace
        metadataJson.packageHash = metadataJson.packageHash
          .trim()
          .replace(/\/$/, "");
      } else if (metadataJson.packageHash) {
        // If packageHash already exists, ensure it's clean
        metadataJson.packageHash = metadataJson.packageHash
          .trim()
          .replace(/\/$/, "");
      } else {
        // If no packageHash can be derived
        metadataJson.packageHash = null;
      }

      // Download package regardless of embedding status
      if (metadataJson.packageHash) {
        console.log("Downloading package hash...", metadataJson.packageHash);
        try {
          void recursiveDownload(metadataJson.packageHash, 3, configInfo.id);
        } catch (error) {
          console.error("Error downloading package hash:", error);
        }
      } else {
        console.log("No package hash found", configInfo.id);
      }

      try {
        dbQueue.add(async () => {
          // Embedding storage logic
          const id = `${configInfo.type}-${configInfo.id}`;
          const checkQuery = `SELECT 1 FROM metadata_embeddings WHERE id = $1`;
          const result = await executeQuery(async (client) => {
            return await client.query(checkQuery, [id]);
          });
          if (result.rows.length > 0) {
            throw new Error("Embedding already exists");
          }

          // Generate embedding from metadata name and description
          const metadataString = `${metadataJson.name || ""} ${
            metadataJson.description || ""
          }`;

          // Clean up the string: remove extra whitespace and newlines
          const cleanedMetadataString = metadataString
            .replace(/\s+/g, " ")
            .trim();

          const embedding = await generateEmbeddingWithRetry(
            cleanedMetadataString
          );

          if (!embedding) {
            throw new Error("Error generating metadata embedding");
          }

          // Build the insert query based on entity type
          let insertQuery = `
          INSERT INTO metadata_embeddings (
            id,
            embedding,
            metadata_content,
            created_at
        `;

          // Add the appropriate ID column based on type
          if (configInfo.type === "component") {
            insertQuery += `, component_id`;
          } else if (configInfo.type === "service") {
            insertQuery += `, service_id`;
          } else if (configInfo.type === "agent") {
            insertQuery += `, agent_id`;
          }

          insertQuery += `) VALUES ($1, $2, $3, CURRENT_TIMESTAMP`;

          // Add the ID value placeholder
          insertQuery += `, $4)`;

          // Create params array with the appropriate values
          const params = [id, embedding, metadataString, configInfo.id];

          // Execute the query
          await executeQuery(async (client) => {
            await client.query(insertQuery, params);
          });

          console.log(
            `Stored embedding for ${configInfo.type} ${configInfo.id}`
          );
        });
      } catch (error) {
        console.error("Error storing metadata embedding:", error);
      }

      // Transform IPFS URLs to gateway URLs
      ["image", "code_uri"].forEach((field) => {
        if (metadataJson[field]?.startsWith("ipfs://")) {
          metadataJson[field] = metadataJson[field].replace(
            "ipfs://",
            "https://gateway.autonolas.tech/ipfs/"
          );
        }
      });

      metadataJson.metadataURI = metadataURI;

      return metadataJson;
    } catch (e) {
      if (attempt === maxRetries - 1) {
        console.log(`Failed after ${maxRetries} attempts:`, e);
        return null;
      }

      // Faster backoff: 500ms base with smaller multiplier (500ms, 1s, 1.5s)
      const backoffTime = Math.min(500 * (attempt + 1), 2000);
      console.log(
        `Attempt ${attempt + 1} failed for ${metadataURI}, retrying in ${
          backoffTime / 1000
        }s...`
      );
      await delay(backoffTime);
    }
  }
};
