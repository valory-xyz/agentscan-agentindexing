import { ponder } from "@/generated";

import { Service, Agent, Component, ServiceAgent } from "../ponder.schema";
import {
  CONTRACT_NAMES,
  createChainScopedId,
  fetchAndTransformMetadata,
  getChainId,
  getChainName,
} from "../utils";

ponder.on(`MainnetAgentRegistry:CreateUnit`, async ({ event, context }) => {
  const agentId = event.args.unitId.toString();
  const metadataJson = await fetchAndTransformMetadata(event.args.unitHash);

  try {
    const existingAgent = await context.db.find(Agent, {
      id: agentId,
    });

    if (existingAgent) {
      // Update existing agent with CreateUnit data
      await context.db
        .update(Agent, {
          id: agentId,
        })
        .set({
          metadata: metadataJson,
          blockNumber: Number(event.block.number),
          timestamp: Number(event.block.timestamp),
          packageHash: metadataJson.packageHash,
          metadataHash: event.args.unitHash,
        });
    } else {
      // Create new agent
      await context.db.insert(Agent).values({
        id: agentId,
        operator: null,
        owner: event.transaction.from,
        agentId: Number(agentId),
        instance: "0x",
        metadataHash: event.args.unitHash,
        metadata: metadataJson,
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
        packageHash: metadataJson.packageHash,
      });
    }
  } catch (e) {
    console.log("error", e);
  }
});

ponder.on(`MainnetAgentRegistry:Transfer`, async ({ event, context }) => {
  const agentId = event.args.id.toString();

  try {
    //try to find the agent
    const existingAgent = await context.db.find(Agent, {
      id: agentId,
    });
    if (existingAgent) {
      // Update the owner of the agent
      await context.db
        .update(Agent, {
          id: agentId,
        })
        .set({
          instance: event.args.to,
        });
    } else {
      console.log("agent not found", agentId);
      //create the agent
      await context.db.insert(Agent).values({
        id: agentId,
        instance: event.args.to,
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
      });
    }
  } catch (e) {
    console.log("error", e);
  }
});

// Add handlers for Component registry events
ponder.on(`MainnetComponentRegistry:CreateUnit`, async ({ event, context }) => {
  const componentId = event.args.unitId.toString();
  const metadataJson = await fetchAndTransformMetadata(event.args.unitHash);

  try {
    const existingComponent = await context.db.find(Component, {
      id: componentId,
    });

    if (existingComponent) {
      // Update existing component with CreateUnit data
      await context.db
        .update(Component, {
          id: componentId,
        })
        .set({
          metadata: metadataJson,
          blockNumber: Number(event.block.number),
          timestamp: Number(event.block.timestamp),
          packageHash: metadataJson.packageHash,
          metadataHash: event.args.unitHash,
        });
    } else {
      // Create new component
      await context.db.insert(Component).values({
        id: componentId,
        instance: "0x",
        metadataHash: event.args.unitHash,
        metadata: metadataJson,
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
        packageHash: metadataJson.packageHash,
      });
    }
  } catch (e) {
    console.log("error", e);
  }
});

ponder.on(`MainnetComponentRegistry:Transfer`, async ({ event, context }) => {
  const componentId = event.args.id.toString();

  try {
    const existingComponent = await context.db.find(Component, {
      id: componentId,
    });

    if (existingComponent) {
      // Update the instance (owner) of the component
      await context.db
        .update(Component, {
          id: componentId,
        })
        .set({
          instance: event.args.to,
        });
    } else {
      console.log("component not found", componentId);
      // Create the component with minimal data
      await context.db.insert(Component).values({
        id: componentId,
        instance: event.args.to,
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
      });
    }
  } catch (e) {
    console.log("error", e);
  }
});

// Add UpdateUnitHash handler for AgentRegistry
ponder.on(`MainnetAgentRegistry:UpdateUnitHash`, async ({ event, context }) => {
  const agentId = event.args.unitId.toString();
  const metadataJson = await fetchAndTransformMetadata(event.args.unitHash);

  try {
    await context.db
      .update(Agent, {
        id: agentId,
      })
      .set({
        metadata: metadataJson,
        metadataHash: event.args.unitHash,
        packageHash: metadataJson?.packageHash,
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
      });
  } catch (e) {
    console.log("error in UpdateUnitHash handler for Agent:", e);
  }
});

// Add UpdateUnitHash handler for ComponentRegistry
ponder.on(
  `MainnetComponentRegistry:UpdateUnitHash`,
  async ({ event, context }) => {
    const componentId = event.args.unitId.toString();
    const metadataJson = await fetchAndTransformMetadata(event.args.unitHash);

    try {
      await context.db
        .update(Component, {
          id: componentId,
        })
        .set({
          metadata: metadataJson,
          metadataHash: event.args.unitHash,
          packageHash: metadataJson?.packageHash,
          blockNumber: Number(event.block.number),
          timestamp: Number(event.block.timestamp),
        });
    } catch (e) {
      console.log("error in UpdateUnitHash handler for Component:", e);
    }
  }
);

// Create event handlers for each contract
CONTRACT_NAMES.forEach((contractName) => {
  ponder.on(`${contractName}:CreateService`, async ({ event, context }) => {
    const chain = getChainName(contractName);
    const serviceId = event.args.serviceId.toString().toLowerCase();
    const metadataJson = await fetchAndTransformMetadata(event.args.configHash);
    const packageHash = metadataJson?.packageHash;
    console.log("packageHash", packageHash);

    try {
      // Create service
      await context.db.insert(Service).values({
        id: createChainScopedId(chain, serviceId),
        chain,
        securityDeposit: 0n,
        multisig: "0x",
        configHash: event.args.configHash,
        threshold: 0,
        maxNumAgentInstances: 0,
        numAgentInstances: 0,
        state: "UNREGISTERED",
        blockNumber: Number(event.block.number),
        chainId: getChainId(chain),
        metadata: metadataJson,
        timestamp: Number(event.block.timestamp),
        metadataHash: event.args.configHash,
        packageHash,
      });
    } catch (e) {
      console.error("Error in CreateService handler:", e);
    }
  });

  ponder.on(`${contractName}:DeployService`, async ({ event, context }) => {
    const chain = getChainName(contractName);

    const serviceId = event.args.serviceId.toString().toLowerCase();

    try {
      await context.db
        .update(Service, {
          id: createChainScopedId(chain, serviceId),
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
    const serviceId = createChainScopedId(
      chain,
      event.args.serviceId.toString().toLowerCase()
    );
    const agentId = event.args.agentId.toString();

    try {
      // Update the agent with instance and operator information
      await context.db
        .update(Agent, {
          id: agentId,
        })
        .set({
          operator: event.args.operator,
          instance: event.args.agentInstance,
        });

      // Update the service's numAgentInstances
      const service = await context.db.find(Service, { id: serviceId });
      if (service) {
        const id = createChainScopedId(chain, serviceId);
        await context.db
          .update(Service, {
            id,
          })
          .set({
            state: "REGISTERED",
          });
      }

      //create a service_agent relation
      await context.db.insert(ServiceAgent).values({
        id: `${serviceId}-${agentId}`,
        serviceId,
        agentId,
      });
    } catch (e) {
      console.log("error in RegisterInstance handler:", e);
    }
  });

  ponder.on(`${contractName}:TerminateService`, async ({ event, context }) => {
    const chain = getChainName(contractName);
    const serviceId = createChainScopedId(
      chain,
      event.args.serviceId.toString().toLowerCase()
    );

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
    const metadataJson = await fetchAndTransformMetadata(event.args.configHash);
    console.log("metadataJson", metadataJson);
    const packageHash = metadataJson?.packageHash;

    const codeURI = metadataJson.code_uri;

    try {
      await context.db
        .update(Service, {
          id: serviceId,
        })
        .set({
          metadata: metadataJson,
          metadataHash: event.args.configHash,
          packageHash,
        });
    } catch (e) {
      console.log("error", e);
    }
  });
});
