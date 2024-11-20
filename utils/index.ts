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
    configInfo as ConfigInfo
  );

  if (metadata?.packageHash) {
    console.log("Downloading package hash...", metadata.packageHash);
    try {
      void recursiveDownload(metadata.packageHash, 15, componentId);
    } catch (error) {
      console.error("package hash download failed:", error);
    }
  } else {
    console.log("No package hash found", componentId);
  }

  return metadata;
};

// Add type definitions for better type safety
interface ConfigInfo {
  type: "component" | "service" | "agent";
  id: string;
}

interface MetadataJson {
  code_uri?: string;
  packageHash?: string | null;
  name?: string;
  description?: string;
  image?: string;
  metadataURI?: string;
  [key: string]: any;
}

// Update fetchAndTransformMetadata with better error handling and types
export const fetchAndTransformMetadata = async (
  configHash: string,
  maxRetries = 3,
  configInfo: ConfigInfo
): Promise<MetadataJson | null> => {
  const metadataPrefix = "f01701220";
  const finishedConfigHash = configHash.slice(2);
  const ipfsURL = "https://gateway.autonolas.tech/ipfs/";
  const metadataURI = `${ipfsURL}${metadataPrefix}${finishedConfigHash}`;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const { data: metadataJson } = await axios.get<MetadataJson>(
        metadataURI,
        {
          timeout: 10000,
        }
      );

      // Extract package hash with improved error handling
      metadataJson.packageHash = extractPackageHash(
        metadataJson.code_uri,
        metadataJson.packageHash
      );

      // Process package download in the background
      if (metadataJson.packageHash) {
        void processPackageDownload(metadataJson.packageHash, configInfo.id);
      }

      // Process metadata embedding in the background
      void processMetadataEmbedding(metadataJson, configInfo);

      // Transform IPFS URLs
      return transformIpfsUrls(metadataJson, metadataURI);
    } catch (error) {
      if (attempt === maxRetries - 1) {
        console.error(
          `Failed to fetch metadata after ${maxRetries} attempts:`,
          error
        );
        return null;
      }
      await handleRetry(attempt, metadataURI);
    }
  }
  return null;
};

// Helper functions for better code organization
function extractPackageHash(
  codeUri?: string,
  existingHash?: string | null
): string | null {
  if (codeUri) {
    if (codeUri.includes("ipfs://")) {
      return codeUri.split("ipfs://")[1]?.trim().replace(/\/$/, "") || null;
    }
    if (codeUri.includes("/ipfs/")) {
      return codeUri.split("/ipfs/")[1]?.trim().replace(/\/$/, "") || null;
    }
    return codeUri.trim().replace(/\/$/, "");
  }
  return existingHash?.trim().replace(/\/$/, "") || null;
}

async function processPackageDownload(packageHash: string, configId: string) {
  try {
    console.log("Downloading package hash...", packageHash);
    void recursiveDownload(packageHash, 15, configId);
  } catch (error) {
    console.error("package hash download failed:", error);
  }
}

async function processMetadataEmbedding(
  metadata: MetadataJson,
  configInfo: ConfigInfo
) {
  try {
    await dbQueue.add(async () => {
      const id = `${configInfo.type}-${configInfo.id}`;

      // Check for existing embedding
      const exists = await checkExistingEmbedding(id);
      if (exists) return;

      // Generate and store embedding
      const metadataString = `${metadata.name || ""} ${
        metadata.description || ""
      }`
        .replace(/\s+/g, " ")
        .trim();
      const embedding = await generateEmbeddingWithRetry(metadataString);

      if (!embedding) {
        throw new Error("metadata embedding generation failed");
      }

      await storeEmbedding(id, embedding, metadataString, configInfo);
    });
  } catch (error) {
    console.error("metadata embedding storage failed:", error);
  }
}

async function checkExistingEmbedding(id: string): Promise<boolean> {
  const result = await executeQuery(async (client) => {
    return await client.query(
      "SELECT 1 FROM metadata_embeddings WHERE id = $1",
      [id]
    );
  });
  return result.rows.length > 0;
}

async function storeEmbedding(
  id: string,
  embedding: number[],
  metadataString: string,
  configInfo: ConfigInfo
) {
  const typeColumn = `${configInfo.type}_id`;

  const query = `
    INSERT INTO metadata_embeddings (
      id,
      embedding,
      metadata_content,
      created_at,
      ${typeColumn}
    ) VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4)
  `;

  await executeQuery(async (client) => {
    await client.query(query, [id, embedding, metadataString, configInfo.id]);
  });

  console.log(`Stored embedding for ${configInfo.type} ${configInfo.id}`);
}

function transformIpfsUrls(
  metadata: MetadataJson,
  metadataURI: string
): MetadataJson {
  const gatewayUrl = "https://gateway.autonolas.tech/ipfs/";

  ["image", "code_uri"].forEach((field) => {
    if (metadata[field]?.startsWith("ipfs://")) {
      metadata[field] = metadata[field]?.replace("ipfs://", gatewayUrl);
    }
  });

  metadata.metadataURI = metadataURI;
  return metadata;
}

async function handleRetry(attempt: number, metadataURI: string) {
  const backoffTime = Math.min(500 * (attempt + 1), 2000);
  console.log(
    `Attempt ${attempt + 1} failed for ${metadataURI}, retrying in ${
      backoffTime / 1000
    }s...`
  );
  await delay(backoffTime);
}
