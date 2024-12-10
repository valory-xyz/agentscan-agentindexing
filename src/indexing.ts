import { ponder } from "ponder:registry";
import {
  Service,
  Agent,
  Component,
  ServiceAgent,
  ComponentDependency,
  ComponentAgent,
  AgentInstance,
} from "ponder:schema";
import {
  CONTRACT_NAMES,
  createChainScopedId,
  fetchAndEmbedMetadataWrapper,
  fetchMetadata,
  getChainId,
  getChainName,
  withErrorBoundary,
} from "../utils";

ponder.on(`MainnetAgentRegistry:CreateUnit`, async ({ event, context }) => {
  const agentId = event.args.unitId.toString();
  console.log(`Handling MainnetAgentRegistry:CreateUnit for agent ${agentId}`);

  await withErrorBoundary(async () => {
    const existingAgent = await context.db.find(Agent, { id: agentId });

    const updateData = {
      name: "",
      description: "",
      image: "",
      codeUri: "",
      blockNumber: Number(event.block.number),
      timestamp: Number(event.block.timestamp),
      packageHash: "",
      metadataHash: event.args.unitHash,
      metadataURI: "",
    };

    if (existingAgent) {
      console.log(`Updating existing agent ${agentId}`);
      await context.db.update(Agent, { id: agentId }).set(updateData);
    } else {
      console.log(`Inserting new agent ${agentId}`);
      await context.db.insert(Agent).values({
        id: agentId,
        ...updateData,
      });
    }

    // Process dependencies with error handling
    try {
      const { client } = context;
      const { MainnetAgentRegistry } = context.contracts;
      const dependencies = await client.readContract({
        abi: MainnetAgentRegistry.abi,
        address: MainnetAgentRegistry.address,
        functionName: "getDependencies",
        args: [event.args.unitId],
      });

      if (dependencies?.[1]?.length > 0) {
        const validDependencies = dependencies[1]
          .map((dep) => dep.toString())
          .filter((dep) => dep !== "")
          .map((dependency) => ({
            id: `${agentId}-${dependency}`,
            agentId,
            componentId: dependency,
          }));

        if (validDependencies.length > 0) {
          console.log(`Inserting dependencies for agent ${agentId}`);
          await context.db.insert(ComponentAgent).values(validDependencies);
        }
      }
    } catch (error) {
      console.error(
        `Failed to process dependencies for agent ${agentId}:`,
        error
      );
    }
  }, `AgentRegistry:CreateUnit for ${agentId}`);
});

ponder.on(`MainnetAgentRegistry:Transfer`, async ({ event, context }) => {
  const agentId = event.args.id.toString();
  console.log(`Handling MainnetAgentRegistry:Transfer for agent ${agentId}`);

  try {
    const existingAgent = await context.db.find(Agent, { id: agentId });

    if (existingAgent) {
      console.log(`Updating operator for agent ${agentId}`);
      await context.db.update(Agent, { id: agentId }).set({
        operator: event.args.to.toString(),
      });
    } else {
      console.log(`Inserting new agent with default data for ${agentId}`);
      await context.db.insert(Agent).values({
        id: agentId,
        operator: event.args.to.toString(),
        name: "", // Default name
        description: "", // Default description
        image: "", // Default image
        codeUri: "", // Default codeUri
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
        packageHash: "", // Default packageHash
        metadataHash: "", // Default metadataHash
        metadataURI: "", // Default metadataURI
      });
    }
  } catch (e) {
    console.error("Error in AgentRegistry:Transfer:", e);
  }
});

ponder.on(`MainnetComponentRegistry:CreateUnit`, async ({ event, context }) => {
  const componentId = event.args.unitId.toString();
  console.log(
    `Handling MainnetComponentRegistry:CreateUnit for component ${componentId}`
  );

  const [metadataJson, existingComponent] = await Promise.all([
    fetchAndEmbedMetadataWrapper(event.args.unitHash, componentId),
    context.db.find(Component, { id: componentId }),
  ]);

  const componentData = {
    id: componentId,
    instance: "0x",
    name: metadataJson?.name || "",
    description: metadataJson?.description || "",
    image: metadataJson?.image || "",
    codeUri: metadataJson?.code_uri || "",
    blockNumber: Number(event.block.number),
    timestamp: Number(event.block.timestamp),
    packageHash: metadataJson?.packageHash || "",
    metadataHash: event.args.unitHash,
    metadataURI: metadataJson?.metadataURI || "",
  };

  try {
    if (existingComponent) {
      console.log(`Updating existing component ${componentId}`);
      await context.db
        .update(Component, { id: componentId })
        .set(componentData);
    } else {
      console.log(`Inserting new component ${componentId}`);
      await context.db.insert(Component).values(componentData);
    }
  } catch (e) {
    console.error("Error in ComponentRegistry:CreateUnit:", e);
  }

  try {
    const { client } = context;

    const { MainnetComponentRegistry } = context.contracts;
    const dependencies = await client.readContract({
      abi: MainnetComponentRegistry.abi,
      address: MainnetComponentRegistry.address,
      functionName: "getDependencies",
      args: [event.args.unitId],
    });

    if (
      dependencies &&
      Array.isArray(dependencies) &&
      dependencies.length === 2
    ) {
      const dependencyArray = dependencies[1];
      if (Array.isArray(dependencyArray) && dependencyArray.length > 0) {
        const validDependencies = dependencyArray
          .map((dep) => dep.toString())
          .filter((dep) => dep !== "")
          .map((dependency) => ({
            id: `${componentId}-${dependency}`,
            componentId,
            dependencyId: dependency,
          }));

        if (validDependencies.length > 0) {
          console.log(`Inserting dependencies for component ${componentId}`);
          await context.db
            .insert(ComponentDependency)
            .values(validDependencies);
        }
      }
    }
  } catch (e) {
    console.error("Error processing dependencies for component:", e);
  }
});

ponder.on(`MainnetComponentRegistry:Transfer`, async ({ event, context }) => {
  const componentId = event.args.id.toString();
  console.log(
    `Handling MainnetComponentRegistry:Transfer for component ${componentId}`
  );

  try {
    const existingComponent = await context.db.find(Component, {
      id: componentId,
    });

    if (existingComponent) {
      console.log(`Updating instance for component ${componentId}`);
      await context.db
        .update(Component, {
          id: componentId,
        })
        .set({
          instance: event.args.to,
        });
    } else {
      console.log(
        `Component not found, inserting new component with minimal data for ${componentId}`
      );
      await context.db.insert(Component).values({
        id: componentId,
        instance: event.args.to,
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
      });
    }
  } catch (e) {
    console.error("Error in ComponentRegistry:Transfer:", e);
  }
});

ponder.on(`MainnetAgentRegistry:UpdateUnitHash`, async ({ event, context }) => {
  const agentId = event.args.unitId.toString();
  console.log(
    `Handling MainnetAgentRegistry:UpdateUnitHash for agent ${agentId}`
  );

  // const metadataJson = await fetchMetadata(
  //   event.args.unitHash,
  //   agentId,
  //   "agent",
  //   false
  // );

  try {
    console.log(`Updating metadata for agent ${agentId}`);
    await context.db.update(Agent, { id: agentId }).set({
      metadata: {},
      blockNumber: Number(event.block.number),
      timestamp: Number(event.block.timestamp),
      packageHash: "",
      metadataHash: event.args.unitHash,
      metadataURI: "",
    });
  } catch (e) {
    console.error("Error in UpdateUnitHash handler for Agent:", e);
  }
});

ponder.on(
  `MainnetComponentRegistry:UpdateUnitHash`,
  async ({ event, context }) => {
    const componentId = event.args.unitId.toString();
    console.log(
      `Handling MainnetComponentRegistry:UpdateUnitHash for component ${componentId}`
    );

    // const metadataJson = await fetchMetadata(
    //   event.args.unitHash,
    //   componentId,
    //   "component",
    //   false
    // );

    try {
      console.log(`Updating metadata for component ${componentId}`);
      await context.db.update(Component, { id: componentId }).set({
        metadata: {},
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
        packageHash: "",
        metadataHash: event.args.unitHash,
        metadataURI: "",
      });
    } catch (e) {
      console.error("Error in UpdateUnitHash handler for Component:", e);
    }
  }
);

CONTRACT_NAMES.forEach((contractName) => {
  ponder.on(`${contractName}:CreateService`, async ({ event, context }) => {
    const chain = getChainName(contractName);
    const serviceId = event.args.serviceId.toString().toLowerCase();
    const cleanServiceId = serviceId.replace(/^service-/, "");
    const chainScopedId = createChainScopedId(chain, cleanServiceId);
    console.log(
      `Handling ${contractName}:CreateService for service ${chainScopedId}`
    );

    const serviceData = {
      id: chainScopedId,
      chain,
      securityDeposit: 0n,
      multisig: "0x",
      configHash: event.args.configHash,
      threshold: 0,
      maxNumAgentInstances: 0,
      numAgentInstances: 0,
      state: "UNREGISTERED" as const,
      blockNumber: Number(event.block.number),
      chainId: getChainId(chain),
      name: "",
      description: "",
      image: "",
      codeUri: "",
      metadataURI: "",
      packageHash: "",
      metadataHash: event.args.configHash,
      timestamp: Number(event.block.timestamp),
    };
    try {
      console.log(`Inserting service ${chainScopedId}`);
      await context.db.insert(Service).values({
        ...serviceData,
        multisig: serviceData.multisig as `0x${string}`,
      });
    } catch (e) {
      console.error(
        `Error inserting service ${chainScopedId}, attempting update`,
        e
      );
      await context.db.update(Service, { id: chainScopedId }).set({
        ...serviceData,
        multisig: serviceData.multisig as `0x${string}`,
      });
    }
  });

  ponder.on(`${contractName}:DeployService`, async ({ event, context }) => {
    const chain = getChainName(contractName);
    const serviceId = event.args.serviceId.toString().toLowerCase();
    const cleanServiceId = serviceId.replace(/^service-/, "");
    const chainScopedId = createChainScopedId(chain, cleanServiceId);
    console.log(
      `Handling ${contractName}:DeployService for service ${chainScopedId}`
    );

    try {
      const service = await context.db.find(Service, { id: chainScopedId });
      if (service) {
        console.log(`Updating state to DEPLOYED for service ${chainScopedId}`);
        await context.db
          .update(Service, {
            id: chainScopedId,
          })
          .set({
            state: "DEPLOYED",
          });
      } else {
        console.warn(`Service not found: ${chainScopedId}`);
      }
    } catch (e) {
      console.error("Error in DeployService handler:", e);
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
      console.log(
        `Handling ${contractName}:CreateMultisigWithAgents for service ${serviceId}`
      );

      try {
        console.log(`Updating multisig for service ${serviceId}`);
        await context.db.update(Service, { id: serviceId }).set({
          multisig: event.args.multisig,
        });
      } catch (e) {
        console.error("Error in CreateMultisigWithAgents handler:", e);
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
    console.log(
      `Handling ${contractName}:RegisterInstance for service ${serviceId} and agent ${agentId}`
    );

    try {
      console.log(`Inserting agent instance for ${agentId}`);
      await context.db.insert(AgentInstance).values({
        id: event.args.agentInstance,
        agentId: agentId,
        serviceId: serviceId,
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
      });

      const service = await context.db.find(Service, { id: serviceId });
      if (service) {
        console.log(`Updating state to REGISTERED for service ${serviceId}`);
        await context.db.update(Service, { id: serviceId }).set({
          state: "REGISTERED",
        });
      }

      console.log(`Inserting service agent for ${serviceId}`);
      await context.db.insert(ServiceAgent).values({
        id: `${serviceId}-${event.args.agentInstance}`,
        serviceId,
        agentInstanceId: event.args.agentInstance,
      });
    } catch (e) {
      console.error("Error in RegisterInstance handler:", e);
    }
  });

  ponder.on(`${contractName}:TerminateService`, async ({ event, context }) => {
    const chain = getChainName(contractName);
    const serviceId = createChainScopedId(
      chain,
      event.args.serviceId.toString().toLowerCase()
    );
    console.log(
      `Handling ${contractName}:TerminateService for service ${serviceId}`
    );

    try {
      console.log(`Updating state to TERMINATED for service ${serviceId}`);
      await context.db
        .update(Service, {
          id: createChainScopedId(chain, serviceId),
        })
        .set({
          state: "TERMINATED",
        });
    } catch (e) {
      console.error("Error in TerminateService handler:", e);
    }
  });

  ponder.on(`${contractName}:UpdateService`, async ({ event, context }) => {
    const chain = getChainName(contractName);
    const serviceId = createChainScopedId(
      chain,
      event.args.serviceId.toString()
    );
    console.log(
      `Handling ${contractName}:UpdateService for service ${serviceId}`
    );

    // const metadataJson = await fetchMetadata(
    //   event.args.configHash,
    //   serviceId,
    //   "service",
    //   false
    // );

    // if (!metadataJson) {
    //   console.warn(`No metadata found for service ${serviceId}`);
    //   return;
    // }

    // const packageHash = metadataJson?.packageHash;

    try {
      console.log(`Updating metadata for service ${serviceId}`);
      await context.db.update(Service, { id: serviceId }).set({
        metadata: {},
        metadataURI: "",
        packageHash: "",
        metadataHash: event.args.configHash,
      });
    } catch (e) {
      console.error("Error in UpdateService handler:", e);
    }
  });
});
