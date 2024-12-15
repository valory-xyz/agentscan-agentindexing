export const SIGNATURES = {
  // ERC20 Events and Functions
  ERC20: {
    TRANSFER_EVENT:
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    TRANSFER_FUNCTION: "0xa9059cbb", // transfer(address,uint256)
    TRANSFER_FROM: "0x23b872dd", // transferFrom(address,address,uint256)
  },

  // ERC721 Events and Functions
  ERC721: {
    TRANSFER_EVENT:
      "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
    TRANSFER: "0x42842e0e", // safeTransferFrom(address,address,uint256)
    TRANSFER_WITH_DATA: "0xb88d4fde", // safeTransferFrom(address,address,uint256,bytes)
  },

  // ERC1155 Functions
  ERC1155: {
    TRANSFER_SINGLE: "0xf242432a", // safeTransferFrom(address,address,uint256,uint256,bytes)
    TRANSFER_BATCH: "0x2eb2c2d6", // safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)
  },

  // Other Events
  EVENTS: {
    FPMM_BUY:
      "0x4f62630f51608fc8a7603a9391a5101e58bd7c276139366fc107dc3b67c3dcf8",
    SAFE_EXECUTION:
      "0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e",
  },

  // Proxy Related
  PROXY: {
    FUNCTION: "0x4f1ef286",
    DELEGATE_CALL: "0x5c60da1b",
  },
} as const;
