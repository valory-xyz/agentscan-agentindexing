import { createConfig, factory, loadBalance, rateLimit } from "ponder";
import { getAbiItem, http, parseAbiItem } from "viem";

import { ServiceRegistryABI } from "./abis/ServiceRegistryABI";
import { AgentRegistryABI } from "./abis/AgentRegistry";
import { ComponentRegistryABI } from "./abis/ComponentRegistry";

export default createConfig({
  networks: {
    mainnet: {
      chainId: 1,
      transport: rateLimit(http(process.env.PONDER_RPC_URL_1), {
        requestsPerSecond: 25,
      }),
      pollingInterval: 2_000,
    },
    gnosis: {
      chainId: 100,
      transport: rateLimit(http(process.env.PONDER_RPC_URL_100), {
        requestsPerSecond: 25,
      }),
      pollingInterval: 2_000,
    },
    base: {
      chainId: 8453,
      transport: rateLimit(http(process.env.PONDER_RPC_URL_8453), {
        requestsPerSecond: 25,
      }),
      pollingInterval: 2_000,
    },
  },
  accounts: {
    MainnetRegisterInstance: {
      network: "mainnet",
      address: factory({
        address: "0x48b6af7B12C71f09e2fC8aF4855De4Ff54e775cA",
        event: getAbiItem({
          abi: ServiceRegistryABI,
          name: "RegisterInstance",
        }),
        parameter: "agentInstance",
      }),
      startBlock: 21270000,
    },
    GnosisRegisterInstance: {
      network: "gnosis",
      address: factory({
        address: "0x9338b5153AE39BB89f50468E608eD9d764B755fD",
        event: getAbiItem({
          abi: ServiceRegistryABI,
          name: "RegisterInstance",
        }),
        parameter: "agentInstance",
      }),
      startBlock: 37200000,
    },
    BaseRegisterInstance: {
      network: "base",
      address: factory({
        address: "0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE",
        event: getAbiItem({
          abi: ServiceRegistryABI,
          name: "RegisterInstance",
        }),
        parameter: "agentInstance",
      }),
      startBlock: 22880000,
    },
  },
  contracts: {
    MainnetStaking: {
      network: "mainnet",
      abi: ServiceRegistryABI,
      address: "0x48b6af7B12C71f09e2fC8aF4855De4Ff54e775cA",
      startBlock: 15178299,
    },
    GnosisRegistry: {
      network: "gnosis",
      abi: ServiceRegistryABI,
      address: "0x9338b5153AE39BB89f50468E608eD9d764B755fD",
      startBlock: 27871084,
    },
    BaseRegistry: {
      network: "base",
      abi: ServiceRegistryABI,
      address: "0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE",
      startBlock: 10827380,
    },
    MainnetAgentRegistry: {
      network: "mainnet",
      abi: AgentRegistryABI,
      address: "0x2F1f7D38e4772884b88f3eCd8B6b9faCdC319112",
      startBlock: 15178299,
    },
    MainnetComponentRegistry: {
      network: "mainnet",
      abi: ComponentRegistryABI,
      address: "0x15bd56669F57192a97dF41A2aa8f4403e9491776",
      startBlock: 15178253,
    },
  },
  database: {
    kind: "postgres",
    connectionString: process.env.DATABASE_URL,
  },
});
