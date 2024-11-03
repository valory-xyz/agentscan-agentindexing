import { createConfig } from "@ponder/core";
import { http } from "viem";

import { FileStoreAbi } from "./abis/FileStoreAbi";
import { MemeAbi } from "./abis/MemeABI";

export default createConfig({
  networks: {
    mainnet: {
      chainId: 1,
      transport: http(process.env.PONDER_RPC_URL_1),
    },
    base: {
      chainId: 8453,
      transport: http(process.env.PONDER_RPC_URL_8453),
    },
  },
  contracts: {
    Meme: {
      network: "base",
      abi: MemeAbi,
      address: "0x42156841253f428cB644Ea1230d4FdDFb70F8891",
      startBlock: 21757872,
      includeCallTraces: true,
    },
  },
});
