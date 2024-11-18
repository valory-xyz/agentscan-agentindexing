import axios from "axios";
import { recursiveDownload } from "./ipfs";

// Helper function to get chain name from contract name
export const getChainName = (contractName: string) => {
  return contractName
    .replace("Registry", "")
    .replace("Staking", "")
    .toLowerCase();
};

// Helper to create unique IDs across chains
export const createChainScopedId = (chain: string, id: string) =>
  `${chain.toLowerCase()}-${id.toLowerCase()}`;

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
  const metadata = await fetchAndTransformMetadata(configHash, maxRetries);
  console.log("metadata", metadata?.packageHash);
  recursiveDownload(metadata?.packageHash, 3, componentId)
    .then(() => {
      return metadata;
    })
    .catch((error) => {
      console.error("Error fetching and embedding metadata:", error);
      return null;
    });
  return metadata;
};

// Add this new helper function
export const fetchAndTransformMetadata = async (
  configHash: string,
  maxRetries = 3
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

      // Extract packageHash with more robust handling
      if (metadataJson.code_uri) {
        // Try different possible formats
        if (metadataJson.code_uri.includes("ipfs://")) {
          metadataJson.packageHash = metadataJson.code_uri.split("ipfs://")[1];
        } else if (metadataJson.code_uri.includes("/ipfs/")) {
          metadataJson.packageHash = metadataJson.code_uri.split("/ipfs/")[1];
        } else {
          console.log("code_uri", metadataJson.code_uri);
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
