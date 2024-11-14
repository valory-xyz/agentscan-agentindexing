import { createConfig } from "@ponder/core";
import { http } from "viem";

import { StakingABI } from "./abis/StakingABI";

export default createConfig({
  networks: {
    mainnet: {
      chainId: 1,
      transport: http(process.env.PONDER_RPC_URL_1),
    },
    polygon: {
      chainId: 137,
      transport: http(process.env.PONDER_RPC_URL_137),
    },
    gnosis: {
      chainId: 100,
      transport: http(process.env.PONDER_RPC_URL_100),
    },
    arbitrum: {
      chainId: 42161,
      transport: http(process.env.PONDER_RPC_URL_42161),
    },
    optimism: {
      chainId: 10,
      transport: http(process.env.PONDER_RPC_URL_10),
    },
    base: {
      chainId: 8453,
      transport: http(process.env.PONDER_RPC_URL_8453),
    },
    celo: {
      chainId: 42220,
      transport: http(process.env.PONDER_RPC_URL_42220),
    },
    // mode: {
    //   chainId: 34443,
    //   transport: http(process.env.PONDER_RPC_URL_34443),
    //   maxRequestsPerSecond: 5,
    // },
  },
  contracts: {
    MainnetStaking: {
      network: "mainnet",
      abi: StakingABI,
      address: "0x48b6af7B12C71f09e2fC8aF4855De4Ff54e775cA",
      startBlock: 15178299,
    },
    PolygonRegistry: {
      network: "polygon",
      abi: StakingABI,
      address: "0xE3607b00E75f6405248323A9417ff6b39B244b50",
      startBlock: 41783952,
    },
    GnosisRegistry: {
      network: "gnosis",
      abi: StakingABI,
      address: "0x9338b5153AE39BB89f50468E608eD9d764B755fD",
      startBlock: 27871084,
    },
    ArbitrumRegistry: {
      network: "arbitrum",
      abi: StakingABI,
      address: "0xE3607b00E75f6405248323A9417ff6b39B244b50",
      startBlock: 174008819,
    },
    OptimismRegistry: {
      network: "optimism",
      abi: StakingABI,
      address: "0x3d77596beb0f130a4415df3D2D8232B3d3D31e44",
      startBlock: 116423039,
    },
    BaseRegistry: {
      network: "base",
      abi: StakingABI,
      address: "0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE",
      startBlock: 10827380,
    },
    CeloRegistry: {
      network: "celo",
      abi: StakingABI,
      address: "0xE3607b00E75f6405248323A9417ff6b39B244b50",
      startBlock: 24205712,
    },
    // ModeRegistry: {
    //   network: "mode",
    //   abi: StakingABI,
    //   address: "0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE",
    //   startBlock: 14444011,
    // },
  },
  database: {
    kind: "postgres",
    connectionString: process.env.DATABASE_URL,
  },
});
