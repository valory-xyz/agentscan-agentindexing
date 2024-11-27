import { ponder } from "@/generated";

import {
  Service,
  Agent,
  Component,
  ServiceAgent,
  ComponentDependency,
  ComponentAgent,
  AgentInstance,
} from "../ponder.schema";
import {
  CONTRACT_NAMES,
  createChainScopedId,
  fetchAndEmbedMetadata,
  fetchAndTransformMetadata,
  getChainId,
  getChainName,
} from "../utils";

async function fetchMetadata(
  hash: string,
  id: string,
  type: "component" | "service" | "agent"
) {
  try {
    return await fetchAndTransformMetadata(hash, 3, { type, id });
  } catch (error) {
    console.error(`Metadata fetch failed for ${type} ${id}:`, error);
    return null;
  }
}

async function fetchAndEmbedMetadataWrapper(hash: string, componentId: string) {
  try {
    return await fetchAndEmbedMetadata(hash, 10, componentId);
  } catch (error) {
    console.error(`Metadata embed failed for component ${componentId}:`, error);
    return null;
  }
}

// Add error boundary wrapper for database operations
async function withErrorBoundary<T>(
  operation: () => Promise<T>,
  errorContext: string
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    console.error(`Error in ${errorContext}:`, error);
    return null;
  }
}

ponder.on(`MainnetAgentRegistry:CreateUnit`, async ({ event, context }) => {
  const agentId = event.args.unitId.toString();

  await withErrorBoundary(async () => {
    const [metadataJson, existingAgent] = await Promise.all([
      fetchMetadata(event.args.unitHash, agentId, "agent"),
      context.db.find(Agent, { id: agentId }),
    ]);

    if (!metadataJson) {
      console.warn(`No metadata found for agent ${agentId}`);
      return;
    }

    const updateData = {
      name: metadataJson.name || "",
      description: metadataJson.description || "",
      image: metadataJson.image || "",
      codeUri: metadataJson.code_uri || "",
      blockNumber: Number(event.block.number),
      timestamp: Number(event.block.timestamp),
      packageHash: metadataJson.packageHash || "",
      metadataHash: event.args.unitHash,
      metadataURI: metadataJson.metadataURI || "",
    };

    if (existingAgent) {
      await context.db.update(Agent, { id: agentId }).set(updateData);
    } else {
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

  try {
    const existingAgent = await context.db.find(Agent, { id: agentId });

    if (existingAgent) {
      await context.db.update(Agent, { id: agentId }).set({
        operator: event.args.to.toString(),
      });
    } else {
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
      await context.db
        .update(Component, { id: componentId })
        .set(componentData);
    } else {
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
          await context.db
            .insert(ComponentDependency)
            .values(validDependencies);
        }
      }
    }
  } catch (e) {
    // console.log("error processing dependencies:", e);
  }
});

ponder.on(`MainnetComponentRegistry:Transfer`, async ({ event, context }) => {
  const componentId = event.args.id.toString();

  try {
    const existingComponent = await context.db.find(Component, {
      id: componentId,
    });

    if (existingComponent) {
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

ponder.on(`MainnetAgentRegistry:UpdateUnitHash`, async ({ event, context }) => {
  const agentId = event.args.unitId.toString();
  const metadataJson = await fetchMetadata(
    event.args.unitHash,
    agentId,
    "agent"
  );

  try {
    await context.db.update(Agent, { id: agentId }).set({
      name: metadataJson?.name || null,
      description: metadataJson?.description || "",
      image: metadataJson?.image || "",
      codeUri: metadataJson?.code_uri || "",
      blockNumber: Number(event.block.number),
      timestamp: Number(event.block.timestamp),
      packageHash: metadataJson?.packageHash || "",
      metadataHash: event.args.unitHash,
      metadataURI: metadataJson?.metadataURI || "",
    });
  } catch (e) {
    // console.error("Error in UpdateUnitHash handler for Agent:", e);
  }
});

ponder.on(
  `MainnetComponentRegistry:UpdateUnitHash`,
  async ({ event, context }) => {
    const componentId = event.args.unitId.toString();
    const metadataJson = await fetchMetadata(
      event.args.unitHash,
      componentId,
      "component"
    );

    try {
      await context.db.update(Component, { id: componentId }).set({
        name: metadataJson?.name || null,
        description: metadataJson?.description || "",
        image: metadataJson?.image || "",
        codeUri: metadataJson?.code_uri || "",
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
        packageHash: metadataJson?.packageHash || "",
        metadataHash: event.args.unitHash,
        metadataURI: metadataJson?.metadataURI || "",
      });
    } catch (e) {
      // console.error("Error in UpdateUnitHash handler for Component:", e);
    }
  }
);

CONTRACT_NAMES.forEach((contractName) => {
  ponder.on(`${contractName}:CreateService`, async ({ event, context }) => {
    const chain = getChainName(contractName);
    const serviceId = event.args.serviceId.toString().toLowerCase();
    const cleanServiceId = serviceId.replace(/^service-/, "");
    const chainScopedId = createChainScopedId(chain, cleanServiceId);

    const metadataJson = await fetchMetadata(
      event.args.configHash,
      chainScopedId,
      "service"
    );
    const packageHash = metadataJson?.packageHash;

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
      name: metadataJson?.name || "",
      description: metadataJson?.description || "",
      image: metadataJson?.image || "",
      codeUri: metadataJson?.code_uri || "",
      metadataURI: metadataJson?.metadataURI || "",
      packageHash: packageHash || "",
      metadataHash: event.args.configHash,
      timestamp: Number(event.block.timestamp),
    };
    try {
      await context.db.insert(Service).values({
        ...serviceData,
        multisig: serviceData.multisig as `0x${string}`,
      });
    } catch (e) {
      //if the service already exists, update it
      await context.db.update(Service, { id: chainScopedId }).set({
        ...serviceData,
        multisig: serviceData.multisig as `0x${string}`,
      });
      // console.error("Error in CreateService handler:", e);
    }
  });

  ponder.on(`${contractName}:DeployService`, async ({ event, context }) => {
    const chain = getChainName(contractName);
    const serviceId = event.args.serviceId.toString().toLowerCase();
    const cleanServiceId = serviceId.replace(/^service-/, "");
    const chainScopedId = createChainScopedId(chain, cleanServiceId);

    try {
      const service = await context.db.find(Service, { id: chainScopedId });
      if (service) {
        await context.db
          .update(Service, {
            id: chainScopedId,
          })
          .set({
            state: "DEPLOYED",
          });
      } else {
        console.log("service not found", chainScopedId);
      }
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
      try {
        await context.db.insert(AgentInstance).values({
          id: event.args.agentInstance,
          agentId: agentId,
          serviceId: serviceId,
          blockNumber: Number(event.block.number),
          timestamp: Number(event.block.timestamp),
        });
      } catch (e) {
        console.log("error inserting agent instance", e);
      }

      const service = await context.db.find(Service, { id: serviceId });
      if (service) {
        await context.db.update(Service, { id: serviceId }).set({
          state: "REGISTERED",
        });
      }

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
    const metadataJson = await fetchMetadata(
      event.args.configHash,
      serviceId,
      "service"
    );

    if (!metadataJson) {
      console.warn(`No metadata found for service ${serviceId}`);
      return;
    }

    const packageHash = metadataJson?.packageHash;

    try {
      await context.db.update(Service, { id: serviceId }).set({
        name: metadataJson.name || "",
        description: metadataJson.description || "",
        image: metadataJson.image || "",
        codeUri: metadataJson.code_uri || "",
        metadataURI: metadataJson.metadataURI || "",
        packageHash,
        metadataHash: event.args.configHash,
      });
    } catch (e) {
      // console.error("Error in UpdateService handler:", e);
    }
  });
});
