import axios from "axios";

// Configure axios instance with optimized settings
const axiosInstance = axios.create({
  timeout: 5000,
  maxContentLength: 500000,
});

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
  "GnosisRegisterInstance",
  "BaseRegisterInstance",
] as const;

export const CONTRACT_NAMES = [
  "MainnetStaking",
  "GnosisRegistry",
  "BaseRegistry",
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

export async function fetchMetadata(
  hash: string,
  id: string,
  type: "component" | "service" | "agent"
): Promise<any> {
  if (!hash) {
    console.warn(`No hash provided for ${type} ${id}`);
    return getDefaultMetadata(type, id);
  }

  try {
    const metadata = await fetchAndTransformMetadata(hash, 2, { type, id });
    return metadata || getDefaultMetadata(type, id);
  } catch (error) {
    console.error(
      `Metadata fetch failed for ${type} ${id} with hash ${hash}:`,
      {
        error: error instanceof Error ? error.message : "Unknown error",
      }
    );
    return getDefaultMetadata(type, id);
  }
}

function getDefaultMetadata(
  type: "component" | "service" | "agent",
  id: string
) {
  return {
    name: null,
    description: null,
    image: null,
    codeUri: null,
    packageHash: null,
    metadataURI: null,
  };
}

export async function fetchAndEmbedMetadataWrapper(
  hash: string,
  componentId: string
) {
  try {
    return await fetchAndEmbedMetadata(hash, 2, componentId);
  } catch (error) {
    console.error(`Metadata embed failed for component ${componentId}:`, error);
    return null;
  }
}

export const fetchAndEmbedMetadata = async (
  configHash: string,
  maxRetries = 2,
  componentId: string
) => {
  const configInfo = {
    type: "component" as const,
    id: componentId,
  };

  return await fetchAndTransformMetadata(configHash, maxRetries, configInfo);
};

interface ConfigInfo {
  type: "component" | "service" | "agent";
  id: string;
}

interface MetadataJson {
  name?: string | null;
  description?: string | null;
  image?: string | null;
  codeUri?: string | null;
  packageHash?: string | null;
  metadataURI?: string;
}

export const fetchAndTransformMetadata = async (
  configHash: string,
  maxRetries = 2,
  configInfo: ConfigInfo
): Promise<MetadataJson | null> => {
  const metadataPrefix = "f01701220";
  const finishedConfigHash = configHash.slice(2);
  const ipfsURL = "https://gateway.autonolas.tech/ipfs/";
  const metadataURI = `${ipfsURL}${metadataPrefix}${finishedConfigHash}`;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const { data } = await axiosInstance.get<MetadataJson>(metadataURI);

      return {
        name: data.name || null,
        description: data.description || null,
        image: transformIpfsUrl(data.image),
        codeUri: transformIpfsUrl(data.codeUri || undefined),
        packageHash: extractPackageHash(
          data.codeUri || undefined,
          data.packageHash
        ),
        metadataURI,
      };
    } catch (error) {
      if (attempt === maxRetries - 1) {
        console.error(`Failed to fetch metadata after ${maxRetries} attempts`);
        return null;
      }
      await delay(Math.min(1000 * (attempt + 1), 2000));
    }
  }

  // Force garbage collection after heavy operations
  if (global.gc) {
    global.gc();
  }

  return null;
};

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

function transformIpfsUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const gatewayUrl = "https://gateway.autonolas.tech/ipfs/";
  return url.startsWith("ipfs://") ? url.replace("ipfs://", gatewayUrl) : url;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
