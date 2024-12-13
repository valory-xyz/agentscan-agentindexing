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
