export function getChainId(chain: string | number): number {
  // If already a number, return it
  if (typeof chain === "number") return chain;

  // Map of chain names to chain IDs
  const chainMap: { [key: string]: number } = {
    mainnet: 1,
    ethereum: 1,
    goerli: 5,
    polygon: 137,
    base: 8453,
    gnosis: 100,
    arbitrum: 42161,
  };

  // Convert chain name to lowercase for consistent matching
  const normalizedChain = chain.toLowerCase();

  // Return mapped chain ID or throw error if not found
  if (chainMap[normalizedChain]) {
    return chainMap[normalizedChain];
  }

  throw new Error(`Unknown chain: ${chain}`);
}
