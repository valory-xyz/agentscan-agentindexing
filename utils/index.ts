import axios from "axios";
import { pool } from "./postgres";
import { generateEmbeddingWithRetry } from "./openai";

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

export async function getImplementationAddress(
  contractAddress: string,
  chainId: number,
  context: any,
  blockNumber: bigint
): Promise<ImplementationResult | null> {
  try {
    if (!contractAddress || contractAddress === "0x") {
      console.log("Invalid contract address provided");
      return null;
    }

    const formattedAddress = contractAddress.toLowerCase();
    if (!formattedAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
      console.log(`Invalid address format: ${contractAddress}`);
      return null;
    }

    const client = context.client;

    // Check both known implementation slots
    const IMPLEMENTATION_SLOTS = [
      "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", // EIP-1967
      "0x0000000000000000000000000000000000000000000000000000000000000000", // Traditional slot
    ];

    for (const slot of IMPLEMENTATION_SLOTS) {
      const implementationAddress = await client.getStorageAt({
        address: formattedAddress as `0x${string}`,
        slot: slot,
        blockNumber: blockNumber,
      });

      if (implementationAddress && implementationAddress !== "0x") {
        // More careful cleaning of the implementation address
        const cleanAddress = "0x" + implementationAddress.slice(-40);

        // Validate the cleaned address
        if (cleanAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
          console.log(
            `Found implementation at slot ${slot} for ${formattedAddress}: ${cleanAddress}`
          );

          // Verify the implementation has code
          const code = await client.getCode({
            address: cleanAddress as `0x${string}`,
            blockNumber: blockNumber,
          });

          if (code && code !== "0x") {
            const implementationAbi = await checkAndStoreAbi(
              cleanAddress,
              chainId,
              context,
              blockNumber
            );

            return {
              address: cleanAddress,
              abi: implementationAbi,
            };
          } else {
            console.log(
              `No code found at implementation address: ${cleanAddress}`
            );
          }
        }
      }
    }

    console.log(`No valid implementation found for ${formattedAddress}`);
    return null;
  } catch (error) {
    console.error(`Error getting implementation address:`, error);
    return null;
  }
}

interface ImplementationResult {
  address: string;
  abi: string | null;
}

export async function checkAndStoreAbi(
  contractAddress: string,
  chainId: number,
  context: any,
  blockNumber: bigint
) {
  try {
    if (!contractAddress || contractAddress === "0x") {
      console.log("Invalid contract address provided");
      return null;
    }

    // Ensure address is properly formatted
    const formattedAddress = contractAddress.toLowerCase();
    if (!formattedAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
      console.log(`Invalid address format: ${contractAddress}`);
      return null;
    }

    console.log(
      `Starting ABI check for ${formattedAddress} on chain ${chainId}`
    );

    const code = await context.client.getCode({
      address: formattedAddress as `0x${string}`,
    });

    if (code === "0x" || !code) {
      console.log(`No code at address ${formattedAddress}`);
      return null;
    }

    // First check if we already have the ABI
    const checkQuery = `
      SELECT abi_text FROM contract_abis 
      WHERE address = $1 AND chain_id = $2
    `;
    const existingAbi = await pool.query(checkQuery, [
      formattedAddress,
      chainId,
    ]);

    if (existingAbi.rows.length > 0) {
      console.log(`Found existing ABI for ${formattedAddress}`);
      return existingAbi.rows[0].abi_text;
    }

    // If not found, fetch from abidata.net
    const network =
      chainId === 8453 ? "base" : chainId === 100 ? "gnosis" : null;
    if (!network) {
      console.log(`Unsupported chain ID: ${chainId}`);
      throw new Error(`Unsupported chain ID: ${chainId}`);
    }

    const url = `https://abidata.net/${contractAddress}?network=${network}`;
    console.log(`Fetching ABI from: ${url}`);

    const response = await axios.get(url, { timeout: 10000 });
    console.log(`API Response status: ${response.status}`);

    if (!response.data?.ok || !response.data.abi) {
      throw new Error("No ABI found in response");
    }

    const abi_text = JSON.stringify(response.data.abi);
    console.log(`ABI text length: ${abi_text.length}`);

    console.log("Generating embedding...");
    const embedding = await generateEmbeddingWithRetry(abi_text);
    console.log(`Embedding generated: ${embedding ? "success" : "failed"}`);

    // Check if this might be a proxy by using a known Gnosis Safe pattern:
    // Gnosis Safe proxy ABI typically has 2 entries: constructor with _singleton, and a fallback.
    let abiObj = JSON.parse(abi_text);
    const isProxy =
      Array.isArray(abiObj) &&
      abiObj.length === 2 &&
      abiObj[0]?.type === "constructor" &&
      abiObj[0]?.inputs?.[0]?.name === "_singleton" &&
      abiObj[1]?.type === "fallback";

    if (isProxy) {
      console.log(
        `Detected proxy contract at ${contractAddress}, fetching implementation...`
      );
      const implementation: ImplementationResult | null =
        await getImplementationAddress(
          contractAddress,
          chainId,
          context,
          BigInt(blockNumber)
        );

      if (implementation?.abi) {
        console.log(
          `Found implementation at ${implementation.address}, storing ABI for proxy`
        );

        // Store the implementation's ABI under the proxy's address
        const embedding = await generateEmbeddingWithRetry(implementation.abi);

        const insertQuery = `
          INSERT INTO contract_abis (
            address,
            chain_id,
            abi_text,
            abi_embedding,
            implementation_address
          ) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (address, chain_id) 
          DO UPDATE SET 
            abi_text = $3,
            abi_embedding = $4,
            implementation_address = $5,
            updated_at = CURRENT_TIMESTAMP
          RETURNING *
        `;

        await pool.query(insertQuery, [
          contractAddress.toLowerCase(),
          chainId,
          implementation.abi,
          embedding,
          implementation.address,
        ]);

        return implementation.abi;
      }
    }

    const insertQuery = `
      INSERT INTO contract_abis (
        address,
        chain_id,
        abi_text,
        abi_embedding
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (address, chain_id) 
      DO UPDATE SET 
        abi_text = $3,
        abi_embedding = $4,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `;

    const result = await pool.query(insertQuery, [
      formattedAddress,
      chainId,
      abi_text,
      embedding,
    ]);

    console.log(`DB Insert Result: ${result.rowCount} rows affected`);
    return abi_text;
  } catch (error: any) {
    console.error(`Error processing ABI for ${contractAddress}:`, {
      message: error.message,
      type: error.constructor.name,
      response: error.response?.data,
      status: error.response?.status,
    });

    const insertQuery = `
      INSERT INTO contract_abis (
        address,
        chain_id,
        abi_text,
        abi_embedding
      ) VALUES ($1, $2, NULL, NULL)
      ON CONFLICT (address, chain_id) DO NOTHING
      RETURNING *
    `;

    try {
      const result = await pool.query(insertQuery, [
        contractAddress.toLowerCase(),
        chainId,
      ]);
      console.log(
        `Stored null values for ${contractAddress}. Rows affected: ${result.rowCount}`
      );
    } catch (dbError: any) {
      console.error(`Database error storing null values:`, {
        message: dbError.message,
        code: dbError.code,
      });
    }

    return null;
  }
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

export async function isSafeTransaction(
  address: string,
  chainId: number,
  context: any
): Promise<boolean> {
  try {
    const checkQuery = `
      SELECT abi_text FROM contract_abis 
      WHERE address = $1 AND chain_id = $2
    `;
    const result = await pool.query(checkQuery, [
      address.toLowerCase(),
      chainId,
    ]);

    if (!result.rows.length) return false;

    const abi = JSON.parse(result.rows[0].abi_text);

    return abi.some(
      (item: any) =>
        item.type === "function" &&
        item.name === "execTransaction" &&
        item.inputs?.length === 10 &&
        item.inputs.some((input: any) => input.name === "signatures")
    );
  } catch (error) {
    console.error("Error checking Safe status:", error);
    return false;
  }
}
