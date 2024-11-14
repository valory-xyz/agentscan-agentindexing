import type { Hex } from "viem";
import { fromHex } from "viem";

import { ponder } from "@/generated";

import { FileStoreFrontendAbi } from "../abis/FileStoreFrontendAbi";
import axios from "axios";

const parseJson = (encodedJson: string, defaultValue: any = null) => {
  try {
    return JSON.parse(encodedJson);
  } catch (e) {
    return defaultValue;
  }
};

// Helper function to get chain name from contract name
const getChainName = (contractName: string) => {
  return contractName
    .replace("Registry", "")
    .replace("Staking", "")
    .toLowerCase();
};

// Helper to create unique IDs across chains
const createChainScopedId = (chain: string, id: string) =>
  `${chain.toLowerCase()}-${id.toLowerCase()}`;

// List all contract names
const CONTRACT_NAMES = [
  "MainnetStaking",
  "PolygonRegistry",
  "GnosisRegistry",
  "ArbitrumRegistry",
  "OptimismRegistry",
  "BaseRegistry",
  "CeloRegistry",
  // "ModeRegistry",
] as const;

// Create event handlers for each contract
CONTRACT_NAMES.forEach((contractName) => {
  ponder.on(`${contractName}:CreateService`, async ({ event, context }) => {
    const chain = getChainName(contractName);
    const serviceId = event.args.serviceId.toString();

    const metadataPrefix = "f01701220";
    const finishedConfigHash = event.args.configHash.slice(2);

    const ipfsURL = "https://gateway.autonolas.tech/ipfs/";
    const tokenURI = `${ipfsURL}${metadataPrefix}${finishedConfigHash}`;

    let metadataJson = null;
    try {
      const metadata = await axios.get(tokenURI);
      metadataJson = metadata.data;

      // Transform image URL if it exists and matches the specified format
      if (metadataJson.image && metadataJson.image.startsWith("ipfs://")) {
        metadataJson.image = metadataJson.image.replace(
          "ipfs://",
          "https://gateway.autonolas.tech/ipfs/"
        );
      }
      if (
        metadataJson.code_uri &&
        metadataJson.code_uri.startsWith("ipfs://")
      ) {
        metadataJson.code_uri = metadataJson.code_uri.replace(
          "ipfs://",
          "https://gateway.autonolas.tech/ipfs/"
        );
      }
    } catch (e) {
      console.log("error", e);
    }

    await context.db.ServiceRegistrationEvent.create({
      id: createChainScopedId(chain, event.log.id),
      data: {
        chain,
        serviceId,
        configHash: event.args.configHash,
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
      },
    });

    await context.db.Service.create({
      id: createChainScopedId(chain, serviceId),
      data: {
        // metadata: metadataJson,
        chain,
        owner: event.transaction.from,
        securityDeposit: 0n,
        multisig: "0x",
        configHash: event.args.configHash,
        threshold: 0,
        maxNumAgentInstances: 0,
        numAgentInstances: 0,
        state: 0,
        blockNumber: Number(event.block.number),
        metadata: metadataJson,
        timestamp: Number(event.block.timestamp),
      },
    });
  });

  ponder.on(`${contractName}:DeployService`, async ({ event, context }) => {
    const chain = getChainName(contractName);

    await context.db.ServiceDeploymentEvent.create({
      id: createChainScopedId(chain, event.log.id),
      data: {
        chain,
        serviceId: event.args.serviceId.toString(),
        multisig: "0x",
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
      },
    });
  });

  ponder.on(
    `${contractName}:CreateMultisigWithAgents`,
    async ({ event, context }) => {
      const chain = getChainName(contractName);
      const serviceId = createChainScopedId(
        chain,
        event.args.serviceId.toString()
      );
      try {
        await context.db.Service.update({
          id: serviceId,
          data: {
            multisig: event.args.multisig,
          },
        });
      } catch (e) {
        console.log("error", e);
      }
    }
  );

  ponder.on(`${contractName}:RegisterInstance`, async ({ event, context }) => {
    const chain = getChainName(contractName);

    await context.db.AgentInstance.create({
      id: createChainScopedId(chain, event.log.id),
      data: {
        chain,
        serviceId: event.args.serviceId.toString(),
        operator: event.args.operator,
        agentId: Number(event.args.agentId),
        instance: event.args.agentInstance,
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
      },
    });
  });

  ponder.on(`${contractName}:OperatorSlashed`, async ({ event, context }) => {
    const chain = getChainName(contractName);

    await context.db.SlashEvent.create({
      id: createChainScopedId(chain, event.log.id),
      data: {
        chain,
        operator: event.args.operator,
        serviceId: event.args.serviceId.toString(),
        amount: event.args.amount,
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
      },
    });
  });

  ponder.on(`${contractName}:TerminateService`, async ({ event, context }) => {
    const chain = getChainName(contractName);
    const serviceId = event.args.serviceId.toString();

    await context.db.ServiceTerminationEvent.create({
      id: createChainScopedId(chain, event.log.id),
      data: {
        chain,
        serviceId,
        refund: 0n,
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
      },
    });

    try {
      await context.db.Service.update({
        id: createChainScopedId(chain, serviceId),
        data: {
          state: 3,
        },
      });
    } catch (e) {
      console.log("error", e);
    }
  });

  ponder.on(`${contractName}:UpdateService`, async ({ event, context }) => {
    const chain = getChainName(contractName);
    const serviceId = createChainScopedId(
      chain,
      event.args.serviceId.toString()
    );
    try {
      await context.db.Service.update({
        id: serviceId,
        data: {
          configHash: event.args.configHash,
        },
      });
    } catch (e) {
      console.log("error", e);
    }
  });

  ponder.on(`${contractName}:Deposit`, async ({ event, context }) => {
    const chain = getChainName(contractName);
    const operatorBalanceId = `${event.args.sender}-${event.log.address}`;

    const existingBalance = await context.db.OperatorBalance.findUnique({
      id: createChainScopedId(chain, operatorBalanceId),
    });

    await context.db.OperatorBalance.upsert({
      id: createChainScopedId(chain, operatorBalanceId),
      create: {
        chain,
        operator: event.args.sender,
        serviceId: event.log.address,
        balance: event.args.amount,
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
      },
      update: {
        balance: (existingBalance?.balance ?? 0n) + event.args.amount,
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
      },
    });
  });
});
