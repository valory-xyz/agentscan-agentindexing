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
    celo: {
      chainId: 42220,
      transport: http(process.env.PONDER_RPC_URL_42220),
    },
  },
  contracts: {
    MemeBase: {
      network: "base",
      abi: MemeAbi,
      address: "0x42156841253f428cB644Ea1230d4FdDFb70F8891",
      startBlock: 21757872,
    },
    MemeCelo: {
      network: "celo",
      abi: MemeAbi,
      address: "0x42156841253f428cB644Ea1230d4FdDFb70F8891",
      startBlock: 28527007,
    },
  },
});
