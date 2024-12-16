import axios from "axios";

import { generateEmbeddingWithRetry } from "./openai";
import { replaceBigInts } from "ponder";
import { createClient } from "redis";
import {
  ConfigInfo,
  ImplementationResult,
  MetadataJson,
  TokenTransferData,
} from "../src/types";
import { executeQuery, pool } from "./postgres";
import { dbQueue, processPackageDownload, safeQueueOperation } from "./ipfs";

const getAbidataRedisKey = (address: string, network: string): string =>
  `abidata:${address.toLowerCase()}:${network}`;

const TTL = 7 * 24 * 60 * 60; // 1 week

const INITIAL_RETRY_DELAY = 5000;

const INITIAL_TIMEOUT = 30000; // 30 seconds
const MAX_TIMEOUT = 60000; // 60 seconds
const TIMEOUT_MULTIPLIER = 1.5;

const MAX_RETRIES = 150;

const axiosInstance = axios.create({
  timeout: 5000,
  maxContentLength: 500000,
});

const redisClient = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});

redisClient.connect().catch(console.error);

export const getChainName = (contractName: string) => {
  return contractName
    .replace("Registry", "")
    .replace("Staking", "")
    .toLowerCase();
};

export const getChainNameFromId = (chainId: number): string => {
  return chainId === 8453 ? "base" : chainId === 100 ? "gnosis" : "mainnet";
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

export async function getImplementationAddress(
  contractAddress: string,
  chainId: number,
  context: any,
  blockNumber: bigint
): Promise<ImplementationResult | null> {
  try {
    console.log(`[IMP] Starting implementation lookup for ${contractAddress}`);

    if (
      !contractAddress ||
      contractAddress === "0x" ||
      contractAddress.toLowerCase() ===
        "0x0000000000000000000000000000000000000000"
    ) {
      console.log("[IMP] Invalid or zero contract address provided");
      return null;
    }

    const formattedAddress = contractAddress.toLowerCase();
    if (!formattedAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
      console.log(`[IMP] Invalid address format: ${contractAddress}`);
      return null;
    }

    // First try getImplementation()
    console.log(
      `[IMP] Attempting getImplementation() call for ${formattedAddress}`
    );
    const GET_IMPLEMENTATION_ABI = [
      {
        inputs: [],
        name: "getImplementation",
        outputs: [{ type: "address", name: "implementation" }],
        stateMutability: "view",
        type: "function",
      },
    ] as const;

    try {
      const implementationAddress = await context.client.readContract({
        address: formattedAddress as `0x${string}`,
        abi: GET_IMPLEMENTATION_ABI,
        functionName: "getImplementation",
        blockNumber: blockNumber,
      });

      if (
        implementationAddress &&
        implementationAddress !== "0x0000000000000000000000000000000000000000"
      ) {
        console.log(
          `[IMP] Found implementation via getImplementation() for ${formattedAddress}: ${implementationAddress}`
        );

        const implementationAbi = await checkAndStoreAbi(
          implementationAddress,
          chainId,
          context,
          blockNumber
        );

        if (implementationAbi) {
          return { address: implementationAddress, abi: implementationAbi };
        }
      }
    } catch (error) {
      console.log(
        "[IMP] No getImplementation function found, trying storage slots..."
      );
    }

    // Try storage slots
    console.log(`[IMP] Checking storage slots for ${formattedAddress}`);
    const PROXY_IMPLEMENTATION_SLOTS = {
      EIP1967:
        "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
      EIP1967_BEACON:
        "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3",
      SIMPLE_PROXY:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      GNOSIS_SAFE_PROXY:
        "0xa619486e6a192c629d6e5c69ba3efd8478c19a6022185a277f24bc5b6e1060f9",
      OPENZEPPELIN_PROXY:
        "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3",
      KARMA_PROXY:
        "0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f",
      SERVICE_STAKING_PROXY:
        "0x9e5e169c1098011e4e5940a3ec1797686b2a8294a9b77a4c676b121bdc0ebb5e",
    } as const;

    for (const [slotType, slot] of Object.entries(PROXY_IMPLEMENTATION_SLOTS)) {
      console.log(`[IMP] Checking ${slotType} slot for ${formattedAddress}`);

      const implementationAddress = await context.client.getStorageAt({
        address: formattedAddress as `0x${string}`,
        slot: slot as `0x${string}`,
        blockNumber: blockNumber,
      });

      if (
        implementationAddress &&
        implementationAddress !== "0x" &&
        implementationAddress !== "0x0000000000000000000000000000000000000000"
      ) {
        const cleanAddress = "0x" + implementationAddress.slice(-40);

        if (
          cleanAddress.match(/^0x[a-fA-F0-9]{40}$/) &&
          cleanAddress.toLowerCase() !==
            "0x0000000000000000000000000000000000000000"
        ) {
          console.log(
            `[IMP] Found implementation at ${slotType} slot for ${formattedAddress}: ${cleanAddress}`
          );

          const implementationAbi = await checkAndStoreAbi(
            cleanAddress,
            chainId,
            context,
            blockNumber
          );

          if (implementationAbi) {
            return { address: cleanAddress, abi: implementationAbi };
          }
        }
      }
    }

    console.log(`[IMP] No valid implementation found for ${formattedAddress}`);
    return null;
  } catch (error) {
    console.error(`[IMP] Error getting implementation address:`, {
      contract: contractAddress,
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });
    return null;
  }
}

export async function checkAndStoreAbi(
  contractAddress: string,
  chainId: number,
  context: any,
  blockNumber: bigint
) {
  const formattedAddress = contractAddress.toLowerCase();
  const addressAndChain = `${formattedAddress}-${getChainNameFromId(chainId)}`;

  try {
    if (
      !contractAddress ||
      contractAddress === "0x" ||
      contractAddress.toLowerCase() ===
        "0x0000000000000000000000000000000000000000"
    ) {
      console.log(`[ABI] Invalid contract address: ${contractAddress}`);
      return null;
    }

    if (!formattedAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
      console.log(`[ABI] Invalid address format: ${contractAddress}`);
      return null;
    }

    const checkQuery = `
      SELECT content as abi_text
      FROM context_embeddings 
      WHERE id = $1 
      AND type = 'abi'
      LIMIT 1;
    `;

    const existingAbi = await pool.query(checkQuery, [addressAndChain]);

    if (existingAbi.rows.length > 0) {
      const abiText = existingAbi.rows[0].abi_text;
      if (typeof abiText === "string") {
        try {
          const parsedAbi = JSON.parse(abiText);

          return parsedAbi;
        } catch (e) {
          console.error(
            `[ABI] Invalid ABI format in database for ${addressAndChain}`
          );
        }
      }
    }

    const network = getChainNameFromId(chainId);

    if (!network) {
      console.error(
        `[ABI] Unsupported chain ID: ${chainId} for ${formattedAddress}`
      );

      throw new Error(`Unsupported chain ID: ${chainId}`);
    }

    const abidataRedisKey = getAbidataRedisKey(formattedAddress, network);
    try {
      const cachedAbidataResponse = await redisClient.get(abidataRedisKey);
      if (cachedAbidataResponse) {
        try {
          const parsedResponse = JSON.parse(cachedAbidataResponse);
          if (Array.isArray(parsedResponse)) {
            const abi_text = JSON.stringify(parsedResponse);
            return await processAbiResponse(
              abi_text,
              formattedAddress,
              chainId,
              context,
              blockNumber
            );
          }
        } catch (e) {
          console.error(
            `[ABI] Invalid cached ABI format for ${formattedAddress}`
          );
        }
      }
    } catch (redisError) {
      console.error(
        `[ABI] Redis error for abidata cache ${formattedAddress}:`,
        {
          error:
            redisError instanceof Error ? redisError.message : "Unknown error",
        }
      );
    }

    const url =
      `https://abidata.net/${contractAddress}?network=${network}`.trim();
    console.log(`[ABI] Fetching ABI from: ${url}`);

    try {
      const response = await fetchWithRetry(url, MAX_RETRIES, INITIAL_TIMEOUT);

      if (!response.data?.ok || !response.data.abi) {
        throw new Error("No ABI found in response");
      }

      const processedAbi = JSON.stringify(response.data.abi);

      await redisClient.set(abidataRedisKey, processedAbi, { EX: TTL });

      return await processAbiResponse(
        processedAbi,
        formattedAddress,
        chainId,
        context,
        blockNumber
      );
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 400) {
        console.log(
          `[ABI] ${formattedAddress} is invalid: ${
            error.response?.data?.message || error.message
          }`
        );

        return null;
      }

      handleFetchError(error, url, formattedAddress);

      return null;
    }
  } catch (error) {
    console.error(`[ABI] Error processing ABI for ${formattedAddress}:`, {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });

    return null;
  }
}

function handleFetchError(error: any, url: string, formattedAddress: string) {
  if (isTimeoutError(error)) {
    console.error(`[ABI] Final timeout for ${url} after all retries`);
  }
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const headers = error.response?.headers;

    console.error(`[ABI] HTTP error fetching ABI for ${formattedAddress}:`, {
      status,
      headers: {
        "retry-after": headers?.["retry-after"],
        "ratelimit-reset": headers?.["ratelimit-reset"],
        "ratelimit-remaining": headers?.["ratelimit-remaining"],
      },
      message: error.message,
      url: error.config?.url,
    });

    if (status === 429) {
      console.error(
        `[ABI] Rate limit exceeded for ${formattedAddress} after all retries`
      );
    }
  } else {
    console.error(`[ABI] Error fetching ABI for ${formattedAddress}:`, {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}

function getChainExplorerUrl(chainId: number, contractAddress: string): string {
  switch (chainId) {
    case 8453:
      return `https://basescan.org/address/${contractAddress}`;
    case 100:
      return `https://gnosisscan.io/address/${contractAddress}`;
    case 1:
    default:
      return `https://etherscan.io/address/${contractAddress}`;
  }
}

async function processAbiResponse(
  abi: any,
  formattedAddress: string,
  chainId: number,
  context: any,
  blockNumber: bigint
) {
  if (!abi) {
    console.error(`[ABI] No ABI provided for ${formattedAddress}`);
    return null;
  }

  if (isProxyContract(abi)) {
    console.log(
      `[ABI] Detected proxy contract at ${formattedAddress}, fetching implementation`
    );
    const implementation = await getImplementationAddress(
      formattedAddress,
      chainId,
      context,
      blockNumber
    );
    console.log(`[ABI] Implementation:`, implementation);

    if (implementation && implementation?.abi) {
      console.log(
        `[ABI] Found implementation at ${implementation.address} for ${formattedAddress}`
      );
      try {
        const embeddings = await generateEmbeddingWithRetry(abi);
        const chainName = getChainNameFromId(chainId);
        const location = getChainExplorerUrl(chainId, formattedAddress);

        await storeAbiInDatabase({
          id: `${formattedAddress}-${chainName}`,
          location,
          content: abi,
          embeddings,
          implementationAddress: implementation?.address || null,
        });

        return abi;
      } catch (error) {
        console.error(
          `[ABI] Error processing implementation ABI for ${formattedAddress}:`,
          error
        );
        throw error;
      }
    }
    return abi;
  }
  console.log(`[ABI] No proxy detected for ${formattedAddress}`, typeof abi);
  const embeddings = await generateEmbeddingWithRetry(abi);
  const chainName = getChainNameFromId(chainId);
  const location = getChainExplorerUrl(chainId, formattedAddress);

  await storeAbiInDatabase({
    id: `${formattedAddress}-${chainName}`,
    location,
    content: abi,
    embeddings,
    implementationAddress: null,
  });

  return abi;
}

async function storeAbiInDatabase({
  id,
  location,
  content,
  embeddings,
  implementationAddress = null as string | null,
}: {
  id: string;
  location: string;
  content: string;
  embeddings: string | string[];
  implementationAddress: string | null;
}) {
  try {
    const promise = await safeQueueOperation(async () => {
      return await dbQueue.add(async () => {
        if (Array.isArray(embeddings)) {
          const results = await Promise.all(
            embeddings.map(async (embedding, index) => {
              const result = await executeQuery(async (client: any) => {
                const queryResult = await client.query(
                  `INSERT INTO context_embeddings (
                    id,
                    company_id,
                    type,
                    location,
                    original_location,
                    content,
                    name,
                    embedding,
                    is_chunk,
                    created_at,
                    updated_at
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())  
                  ON CONFLICT (id, type, location) DO UPDATE SET
                    content = EXCLUDED.content,
                    embedding = EXCLUDED.embedding,
                    updated_at = NOW()
                  RETURNING id`,
                  [
                    `${id}-${index}`,
                    "olas",
                    "abi",
                    location,
                    implementationAddress
                      ? getChainExplorerUrl(
                          getChainId(id.split("-")[1] || "mainnet"),
                          implementationAddress
                        )
                      : null,
                    content,
                    id.split("-")[0],
                    embedding,
                    true,
                  ]
                );
                console.log(
                  `[ABI] Chunk ${index}: ${
                    queryResult.rows.length > 0
                      ? "Updated/Inserted"
                      : "No changes"
                  } for ${id}`
                );
                return queryResult;
              });
              return result.rows.length > 0;
            })
          );
          return results.every(Boolean);
        } else {
          const result = await executeQuery(async (client: any) => {
            const queryResult = await client.query(
              `INSERT INTO context_embeddings (
                id,
                company_id,
                type,
                location,
                original_location,
                content,
                name,
                embedding,
                is_chunk,
                created_at,
                updated_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())  
              ON CONFLICT (id, type, location) DO UPDATE SET
                content = EXCLUDED.content,
                embedding = EXCLUDED.embedding,
                updated_at = NOW()
              RETURNING id`,
              [
                id,
                "olas",
                "abi",
                location,
                implementationAddress
                  ? getChainExplorerUrl(
                      getChainId(id.split("-")[1] || "mainnet"),
                      implementationAddress
                    )
                  : null,
                content,
                id.split("-")[0],
                embeddings,
                false,
              ]
            );
            console.log(
              `[ABI] ${
                queryResult.rows.length > 0 ? "Updated/Inserted" : "No changes"
              } for ${id}`
            );
            return queryResult;
          });
          return result.rows.length > 0;
        }
      });
    });

    if (promise) {
      console.log(
        `[ABI] Successfully stored ${
          Array.isArray(embeddings) ? embeddings.length + " chunks" : "ABI"
        } for ${id} in database`
      );
    } else {
      console.log(`[ABI] No changes made to database for ${id}`);
    }

    return promise;
  } catch (error) {
    console.error(`[ABI] Database error storing ABI for ${id}:`, {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
      details: {
        id,
        type: "abi",
        location,
        isChunked: Array.isArray(embeddings),
        chunksCount: Array.isArray(embeddings) ? embeddings.length : 0,
      },
    });
    throw error;
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
      const { data } = await axiosInstance.get<any>(metadataURI);

      let codeUri = data?.code_uri || data?.codeUri || null;
      let image = data?.image || null;

      if (codeUri && codeUri.startsWith("ipfs://")) {
        codeUri = transformIpfsUrl(codeUri);
      }

      if (image && image.startsWith("ipfs://")) {
        image = transformIpfsUrl(image);
      }

      const metadataJson = {
        name: data.name || null,
        description: data.description || null,
        image: data.image || null,
        codeUri: data.code_uri || data.codeUri || null,
        packageHash: extractPackageHash(
          data.codeUri || data.code_uri || undefined,
          data.packageHash
        ),
        metadataURI,
      };
      console.log(
        `[Metadata] Found metadata for ${configInfo.id}: ${metadataJson.name}`
      );

      if (metadataJson.packageHash) {
        void processPackageDownload(metadataJson.packageHash, configInfo.id);
      }
      return metadataJson;
    } catch (error) {
      if (attempt === maxRetries - 1) {
        console.error(`Failed to fetch metadata after ${maxRetries} attempts`);
        return null;
      }
      await delay(Math.min(1000 * (attempt + 1), 2000));
    }
  }

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

export function transformIpfsUrl(
  url: string | null | undefined
): string | null {
  if (!url) return null;
  const gatewayUrl = "https://gateway.autonolas.tech/ipfs/";
  return url.startsWith("ipfs://") ? url.replace("ipfs://", gatewayUrl) : url;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function convertBigIntsToStrings(obj: any): any {
  return replaceBigInts(obj, (v) => String(v));
}

export function isProxyContract(abi: string): boolean {
  try {
    const abiObj = JSON.parse(abi);

    // Check for SERVICE_STAKING_PROXY constant and getImplementation function
    const isServiceStakingProxy =
      Array.isArray(abiObj) &&
      abiObj.some(
        (item) =>
          item.type === "function" &&
          item.name === "SERVICE_STAKING_PROXY" &&
          item.outputs?.[0]?.type === "bytes32"
      ) &&
      abiObj.some(
        (item) =>
          item.type === "function" &&
          item.name === "getImplementation" &&
          item.outputs?.[0]?.type === "address"
      );

    if (isServiceStakingProxy) {
      console.log("[ABI] Detected Service Staking Proxy Pattern");
      return true;
    }

    // Existing Gnosis Safe Proxy pattern check
    const isGnosisSafeProxy =
      Array.isArray(abiObj) &&
      abiObj.some(
        (item) => item.type === "fallback" && item.stateMutability === "payable"
      ) &&
      abiObj.some(
        (item) =>
          item.type === "constructor" &&
          item.inputs?.length === 1 &&
          item.inputs[0].type === "address" &&
          (item.inputs[0].name === "_singleton" ||
            item.inputs[0].name === "singleton")
      );

    if (isGnosisSafeProxy) {
      console.log("[ABI] Detected Gnosis Safe Proxy Pattern");
      return true;
    }

    // Generic getImplementation pattern check
    const hasGetImplementation =
      Array.isArray(abiObj) &&
      abiObj.some(
        (item: any) =>
          item.type === "function" &&
          item.name === "getImplementation" &&
          item.outputs?.length === 1 &&
          item.outputs[0].type === "address"
      );

    if (hasGetImplementation) {
      console.log("[ABI] Detected getImplementation Pattern");
      return true;
    }

    // Add the custom storage slot to PROXY_IMPLEMENTATION_SLOTS in getImplementationAddress
    const SERVICE_STAKING_SLOT =
      "0x9e5e169c1098011e4e5940a3ec1797686b2a8294a9b77a4c676b121bdc0ebb5e";

    console.log("[ABI] No proxy pattern detected");
    return false;
  } catch (error) {
    console.error("[ABI] Error checking proxy status:", {
      error: error instanceof Error ? error.message : "Unknown error",
      abi,
    });
    return false;
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function getRetryDelay(error: any, attempt: number = 0): number {
  const BASE_DELAY = 12000;
  const MAX_DELAY = 60000;

  if (axios.isAxiosError(error) && error.response?.headers) {
    const headers = error.response.headers;

    if (headers["retry-after"]) {
      const retryAfter = headers["retry-after"];

      if (isNaN(retryAfter as any)) {
        const retryDate = new Date(retryAfter);
        if (!isNaN(retryDate.getTime())) {
          const delay = Math.max(0, retryDate.getTime() - Date.now());
          console.log(
            `[ABI] Retry-After (date): ${new Date(
              retryDate
            ).toISOString()}, delay: ${delay}ms`
          );
          return delay * 1.25;
        }
      }

      const secondsDelay = parseInt(retryAfter) * 1000;
      if (!isNaN(secondsDelay)) {
        console.log(`[ABI] Retry-After (seconds): ${secondsDelay}ms`);
        return secondsDelay * 1.25;
      }
    }

    if (headers["ratelimit-reset"]) {
      const resetTimestamp = parseInt(headers["ratelimit-reset"]) * 1000;
      const delay = Math.max(0, resetTimestamp - Date.now());
      console.log(`[ABI] Rate limit reset delay: ${delay}ms`);
      return delay * 1.25;
    }

    if (error.response.status === 429) {
      const exponentialDelay = Math.min(
        MAX_DELAY,
        BASE_DELAY * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5)
      );
      console.log(
        `[ABI] Rate limit exponential backoff delay: ${exponentialDelay}ms`
      );
      return exponentialDelay * 1.25;
    }
  }

  // Default exponential backoff for other errors
  const defaultDelay = Math.min(MAX_DELAY, BASE_DELAY * Math.pow(1.5, attempt));
  console.log(`[ABI] Default delay: ${defaultDelay}ms`);
  return defaultDelay;
}

function isTimeoutError(error: any): boolean {
  return (
    axios.isAxiosError(error) &&
    (error.code === "ECONNABORTED" || error.message.includes("timeout"))
  );
}

async function fetchWithRetry(
  url: string,
  retries = MAX_RETRIES,
  timeout = INITIAL_TIMEOUT
): Promise<any> {
  let lastError: any;
  let currentTimeout = timeout;

  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url, {
        timeout: currentTimeout,
        headers: {
          Accept: "application/json",
        },
      });
      return response;
    } catch (error) {
      lastError = error;

      if (axios.isAxiosError(error)) {
        if (error.response?.status === 400) {
          throw error;
        }

        const status = error.response?.status;
        const headers = error.response?.headers;

        const isTimeout =
          error.code === "ECONNABORTED" || error.message.includes("timeout");
        const isRateLimit = status === 429;

        console.error(`[ABI] HTTP error fetching ABI from ${url}:`, {
          status,
          headers: {
            "retry-after": headers?.["retry-after"],
            "ratelimit-reset": headers?.["ratelimit-reset"],
            "ratelimit-remaining": headers?.["ratelimit-remaining"],
          },
          message: error.message,
          code: error.code,
          url: error.config?.url,
        });

        if (!isTimeout && !isRateLimit) {
          throw error;
        }

        const waitTime = isRateLimit
          ? getRetryDelay(error, i)
          : isTimeout
          ? Math.min(currentTimeout * TIMEOUT_MULTIPLIER, MAX_TIMEOUT) -
            currentTimeout
          : INITIAL_RETRY_DELAY;

        const remainingAttempts = retries - i - 1;

        if (isTimeout) {
          console.log(
            `[ABI] Timeout fetching ABI from ${url}. ` +
              `Attempt ${i + 1}/${retries}. ` +
              `Increasing timeout from ${currentTimeout}ms to ${Math.min(
                currentTimeout * TIMEOUT_MULTIPLIER,
                MAX_TIMEOUT
              )}ms. ` +
              `(${remainingAttempts} attempts remaining)`
          );
          currentTimeout = Math.min(
            currentTimeout * TIMEOUT_MULTIPLIER,
            MAX_TIMEOUT
          );
        } else if (isRateLimit) {
          console.log(
            `[ABI] Rate limited by abidata.net. Attempt ${i + 1}/${retries}. ` +
              `Waiting ${Math.round(waitTime / 1000)}s... ` +
              `(${remainingAttempts} attempts remaining)`
          );
        } else {
          console.log(
            `[ABI] Error fetching ABI from ${url}. ` +
              `Attempt ${i + 1}/${retries}. ` +
              `Status: ${status}. Error: ${error.message}. ` +
              `Waiting ${Math.round(waitTime / 1000)}s... ` +
              `(${remainingAttempts} attempts remaining)`
          );
        }

        await wait(waitTime);
        continue;
      } else {
        // Non-Axios error
        console.error(`[ABI] Non-HTTP error fetching ABI from ${url}:`, {
          error:
            error instanceof Error
              ? {
                  message: error.message,
                  stack: error.stack,
                  name: error.name,
                }
              : "Unknown error type",
          type: typeof error,
        });
      }
    }
  }

  const errorDetails =
    lastError instanceof Error
      ? {
          message: lastError.message,
          stack: lastError.stack,
          name: lastError.name,
          type: typeof lastError,
          isAxiosError: axios.isAxiosError(lastError),
          status: axios.isAxiosError(lastError)
            ? lastError.response?.status
            : undefined,
          code: axios.isAxiosError(lastError) ? lastError.code : undefined,
        }
      : {
          error: lastError,
        };

  console.error(
    `[ABI] Failed after ${retries} retries for ${url}. Error details:`,
    errorDetails
  );

  throw new Error(
    `Failed after ${retries} retries. Error: ${
      lastError instanceof Error
        ? lastError.message
        : JSON.stringify(errorDetails)
    }`
  );
}
