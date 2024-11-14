import { ponder } from "@/generated";

import axios from "axios";

import {
  ServiceRegistrationEvent,
  ServiceDeploymentEvent,
  ServiceTerminationEvent,
  SlashEvent,
  Service,
  AgentInstance,
  OperatorBalance,
} from "./../ponder.schema";

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

const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

// Create event handlers for each contract
CONTRACT_NAMES.forEach((contractName) => {
  ponder.on(`${contractName}:CreateService`, async ({ event, context }) => {
    const chain = getChainName(contractName);
    const serviceId = event.args.serviceId.toString().toLowerCase();

    const metadataPrefix = "f01701220";
    const finishedConfigHash = event.args.configHash.slice(2);

    const ipfsURL = "https://gateway.autonolas.tech/ipfs/";
    const tokenURI = `${ipfsURL}${metadataPrefix}${finishedConfigHash}`;

    let metadataJson = null;
    try {
      const metadata = await axios.get(tokenURI);
      metadataJson = metadata.data;

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

    await context.db.insert(ServiceRegistrationEvent).values({
      id: createChainScopedId(chain, event.log.id),
      chain,
      serviceId: createChainScopedId(chain, serviceId),
      configHash: event.args.configHash,
      blockNumber: Number(event.block.number),
      timestamp: Number(event.block.timestamp),
    });

    await context.db.insert(Service).values({
      id: createChainScopedId(chain, serviceId),
      chain,
      owner: event.transaction.from,
      securityDeposit: 0n,
      multisig: "0x",
      configHash: event.args.configHash,
      threshold: 0,
      maxNumAgentInstances: 0,
      numAgentInstances: 0,
      state: "UNREGISTERED",
      blockNumber: Number(event.block.number),
      metadata: metadataJson,
      timestamp: Number(event.block.timestamp),
    });

    const serviceData = {
      type: "service" as const,
      id: createChainScopedId(chain, serviceId),
      chain,
      owner: event.transaction.from,
      securityDeposit: 0n,
      multisig: "0x",
      configHash: event.args.configHash,
      threshold: 0,
      maxNumAgentInstances: 0,
      numAgentInstances: 0,
      state: "UNREGISTERED",
      blockNumber: Number(event.block.number),
      metadata: metadataJson,
      timestamp: Number(event.block.timestamp),
    };
  });

  ponder.on(`${contractName}:DeployService`, async ({ event, context }) => {
    const chain = getChainName(contractName);

    await context.db.insert(ServiceDeploymentEvent).values({
      id: createChainScopedId(chain, event.log.id),
      chain,
      serviceId: createChainScopedId(chain, event.args.serviceId.toString()),
      multisig: "0x",
      blockNumber: Number(event.block.number),
      timestamp: Number(event.block.timestamp),
    });
    console.log("deploying service", event.args.serviceId.toString());
    try {
      await context.db
        .update(Service, {
          id: createChainScopedId(chain, event.args.serviceId.toString()),
        })
        .set({
          state: "DEPLOYED",
        });
    } catch (e) {
      console.log("error", e);
    }
  });

  ponder.on(
    `${contractName}:CreateMultisigWithAgents`,
    async ({ event, context }) => {
      const chain = getChainName(contractName);
      const serviceId = createChainScopedId(
        chain,
        event.args.serviceId.toString().toLowerCase()
      );
      try {
        await context.db.update(Service, { id: serviceId }).set({
          multisig: event.args.multisig,
        });
      } catch (e) {
        console.log("error", e);
      }
    }
  );

  ponder.on(`${contractName}:RegisterInstance`, async ({ event, context }) => {
    const chain = getChainName(contractName);

    await context.db.insert(AgentInstance).values({
      id: createChainScopedId(chain, event.log.id),
      chain,
      serviceId: createChainScopedId(chain, event.args.serviceId.toString()),
      operator: event.args.operator,
      agentId: Number(event.args.agentId),
      instance: event.args.agentInstance,
      blockNumber: Number(event.block.number),
      timestamp: Number(event.block.timestamp),
    });
  });

  ponder.on(`${contractName}:OperatorSlashed`, async ({ event, context }) => {
    const chain = getChainName(contractName);

    await context.db.insert(SlashEvent).values({
      id: createChainScopedId(chain, event.log.id),
      chain,
      operator: event.args.operator,
      serviceId: createChainScopedId(chain, event.args.serviceId.toString()),
      amount: event.args.amount,
      blockNumber: Number(event.block.number),
      timestamp: Number(event.block.timestamp),
    });
  });

  ponder.on(`${contractName}:TerminateService`, async ({ event, context }) => {
    const chain = getChainName(contractName);
    const serviceId = event.args.serviceId.toString();

    await context.db.insert(ServiceTerminationEvent).values({
      id: createChainScopedId(chain, event.log.id),
      chain,
      serviceId: createChainScopedId(chain, serviceId),
      refund: 0n,
      blockNumber: Number(event.block.number),
      timestamp: Number(event.block.timestamp),
    });

    try {
      await context.db
        .update(Service, {
          id: createChainScopedId(chain, serviceId),
        })
        .set({
          state: "TERMINATED",
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
      await context.db
        .update(Service, {
          id: serviceId,
        })
        .set({
          configHash: event.args.configHash,
        });
    } catch (e) {
      console.log("error", e);
    }
  });

  ponder.on(`${contractName}:Deposit`, async ({ event, context }) => {
    const chain = getChainName(contractName);
    const operatorBalanceId = `${event.args.sender}-${event.log.address}`;

    const existingBalance = await context.db.find(OperatorBalance, {
      id: createChainScopedId(chain, operatorBalanceId),
    });

    if (existingBalance) {
      await context.db
        .update(OperatorBalance, {
          id: createChainScopedId(chain, operatorBalanceId),
        })
        .set({
          balance: existingBalance.balance + event.args.amount,
        });
    } else {
      await context.db.insert(OperatorBalance).values({
        id: createChainScopedId(chain, operatorBalanceId),
        chain,
        operator: event.args.sender,
        serviceId: event.log.address,
        balance: event.args.amount,
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
      });
    }
  });
});
