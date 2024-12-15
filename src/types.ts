export interface TokenTransferData {
  type: "ERC20" | "ERC721" | "ERC1155" | "UNKNOWN";
  from?: string;
  to?: string;
  tokenId?: string;
  amount?: string;
  data?: string;
  decodedFunction?: {
    functionName: string;
    args: any;
  };
}

export interface ImplementationResult {
  address: string;
  abi: string | null;
}

export interface ConfigInfo {
  type: "component" | "service" | "agent";
  id: string;
}

export interface MetadataJson {
  name?: string | null;
  description?: string | null;
  image?: string | null;
  codeUri?: string | null;
  packageHash?: string | null;
  metadataURI?: string;
}
