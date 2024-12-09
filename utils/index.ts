import axios from "axios";
import NodeCache from "node-cache";

export const getChainName = (contractName: string) => {
  return contractName
    .replace("Registry", "")
    .replace("Staking", "")
    .toLowerCase();
};

export const createChainScopedId = (
  chain: string,
  serviceId: string
): string => {
  const cleanId = serviceId
    .replace(/^service-/g, "")
    .replace(new RegExp(`^${chain}-`, "i"), "");

  return `${chain}-${cleanId}`;
};

export const REGISTER_NAMES = [
  "MainnetRegisterInstance",
  "PolygonRegisterInstance",
  "GnosisRegisterInstance",
  "ArbitrumRegisterInstance",
  "OptimismRegisterInstance",
  "BaseRegisterInstance",
] as const;

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
      return 1;
  }
};

const metadataCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 600,
  useClones: false,
  maxKeys: 4000,
});

export async function fetchMetadata(
  hash: string,
  id: string,
  type: "component" | "service" | "agent",
  useCache: boolean = true
): Promise<any> {
  const cacheKey = `${hash}-${id}-${type}`;

  if (useCache) {
    const cachedData = metadataCache.get(cacheKey);
    if (cachedData) {
      return cachedData;
    }
  }

  try {
    const metadata = await fetchAndTransformMetadata(hash, 3, { type, id });

    if (metadata) {
      metadataCache.set(cacheKey, metadata);
    }

    return metadata;
  } catch (error) {
    console.error(`Metadata fetch failed for ${type} ${id}:`, error);
    return null;
  }
}

metadataCache.on("error", (err) => {
  console.error("Cache error:", err);
});

export async function fetchAndEmbedMetadataWrapper(
  hash: string,
  componentId: string
) {
  try {
    return await fetchAndEmbedMetadata(hash, 5, componentId);
  } catch (error) {
    console.error(`Metadata embed failed for component ${componentId}:`, error);
    return null;
  }
}

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

  return metadata;
};

export async function withErrorBoundary<T>(
  operation: () => Promise<T>,
  errorContext: string
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    console.error(`Error in ${errorContext}:`, error);
    return null;
  }
}

interface ConfigInfo {
  type: "component" | "service" | "agent";
  id: string;
}

interface MetadataJson {
  name?: string | null;
  description?: string | null;
  image?: string | null;
  code_uri?: string | null;
  packageHash?: string | null;
  metadataURI?: string;
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
      const { data } = await axios.get<MetadataJson>(metadataURI, {
        timeout: 10000,
      });

      const metadataJson: MetadataJson = {
        name: data.name || null,
        description: data.description || null,
        image: data.image || null,
        code_uri: data.code_uri || null,
        packageHash: extractPackageHash(
          data.code_uri ?? undefined,
          data.packageHash
        ),
        metadataURI: metadataURI,
      };

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

function transformIpfsUrls(
  metadata: MetadataJson,
  metadataURI: string
): MetadataJson {
  const gatewayUrl = "https://gateway.autonolas.tech/ipfs/";

  return {
    ...metadata,
    image: metadata.image?.startsWith("ipfs://")
      ? metadata.image.replace("ipfs://", gatewayUrl)
      : metadata.image,
    code_uri: metadata.code_uri?.startsWith("ipfs://")
      ? metadata.code_uri.replace("ipfs://", gatewayUrl)
      : metadata.code_uri,
    metadataURI: metadataURI,
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function handleRetry(attempt: number, metadataURI: string) {
  const backoffTime = Math.min(500 * (attempt + 1), 2000);
  console.log(
    `Attempt ${attempt + 1} failed for ${metadataURI}, retrying in ${
      backoffTime / 1000
    }s...`
  );
  await delay(backoffTime);
}
