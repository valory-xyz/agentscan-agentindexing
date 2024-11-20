import { ponder } from "@/generated";
import { memoize, MemoizedFunction } from "lodash";

import {
  Service,
  Agent,
  Component,
  ServiceAgent,
  ComponentDependency,
  ComponentAgent,
} from "../ponder.schema";
import {
  CONTRACT_NAMES,
  createChainScopedId,
  fetchAndEmbedMetadata,
  fetchAndTransformMetadata,
  getChainId,
  getChainName,
} from "../utils";

// Add cache invalidation timeout
const CACHE_TIMEOUT = 1000 * 60 * 5; // 5 minutes

// Update memoization with cache timeout and error handling
const memoizedFetchMetadata = memoize(
  async (hash: string, id: string, type: "component" | "service" | "agent") => {
    try {
      const result = await fetchAndTransformMetadata(hash, 3, { type, id });
      return result;
    } catch (error) {
      console.error(`Metadata fetch failed for ${type} ${id}:`, error);
      return null;
    }
  },
  (hash: string, id: string, type: string) => `${hash}-${id}-${type}`
);

// Add cache clearing mechanism
const clearMemoizationCache = () => {
  (memoizedFetchMetadata as MemoizedFunction).cache?.clear?.();
  (memoizedFetchAndEmbedMetadata as MemoizedFunction).cache?.clear?.();
};

// Set up periodic cache clearing
setInterval(clearMemoizationCache, CACHE_TIMEOUT);

// Update the memoized fetch and embed with better error handling
const memoizedFetchAndEmbedMetadata = memoize(
  async (hash: string, componentId: string) => {
    try {
      const result = await fetchAndEmbedMetadata(hash, 3, componentId);
      return result;
    } catch (error) {
      console.error(
        `Metadata embed failed for component ${componentId}:`,
        error
      );
      return null;
    }
  },
  (hash: string, componentId: string) => `${hash}-${componentId}`
);

// Add error boundary wrapper for database operations
async function withErrorBoundary<T>(
  operation: () => Promise<T>,
  errorContext: string
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    console.error(`Error in ${errorContext}:`, error);
    // Clear cache on error to prevent stale data
    clearMemoizationCache();
    return null;
  }
}

// Update the CreateUnit handler with error boundary
ponder.on(`MainnetAgentRegistry:CreateUnit`, async ({ event, context }) => {
  const agentId = event.args.unitId.toString();

  return withErrorBoundary(async () => {
    const [metadataJson, existingAgent] = await Promise.all([
      memoizedFetchMetadata(event.args.unitHash, agentId, "agent"),
      context.db.find(Agent, { id: agentId }),
    ]);

    if (!metadataJson) {
      console.warn(`No metadata found for agent ${agentId}`);
      return;
    }

    if (existingAgent) {
      await context.db.update(Agent, { id: agentId }).set({
        metadata: metadataJson,
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
        packageHash: metadataJson?.packageHash,
        metadataHash: event.args.unitHash,
        metadataURI: metadataJson?.metadataURI,
      });
    } else {
      await context.db.insert(Agent).values({
        id: agentId,
        operator: null,
        instance: "0x",
        metadataHash: event.args.unitHash,
        metadata: metadataJson,
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
        packageHash: metadataJson?.packageHash,
        metadataURI: metadataJson?.metadataURI,
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

  // Use memoized fetch and parallel processing
  const [metadataJson, existingComponent] = await Promise.all([
    memoizedFetchAndEmbedMetadata(event.args.unitHash, componentId),
    context.db.find(Component, { id: componentId }),
  ]);

  try {
    if (existingComponent) {
      await context.db.update(Component, { id: componentId }).set({
        metadata: metadataJson,
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
        packageHash: metadataJson?.packageHash,
        metadataHash: event.args.unitHash,
        metadataURI: metadataJson?.metadataURI,
      });
    } else {
      await context.db.insert(Component).values({
        id: componentId,
        instance: "0x",
        metadataHash: event.args.unitHash,
        metadata: metadataJson,
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
        packageHash: metadataJson?.packageHash,
        metadataURI: metadataJson?.metadataURI,
      });
    }
  } catch (e) {
    // console.error("Error in ComponentRegistry:CreateUnit:", e);
  }

  //call
  try {
    const { client } = context;
    //      ^? ReadonlyClient<"mainnet">
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
  const metadataJson = await memoizedFetchMetadata(
    event.args.unitHash,
    agentId,
    "agent"
  );

  try {
    await context.db.update(Agent, { id: agentId }).set({
      metadata: metadataJson,
      metadataHash: event.args.unitHash,
      packageHash: metadataJson?.packageHash,
      blockNumber: Number(event.block.number),
      timestamp: Number(event.block.timestamp),
      metadataURI: metadataJson?.metadataURI,
    });
  } catch (e) {
    // console.error("Error in UpdateUnitHash handler for Agent:", e);
  }
});

// Add UpdateUnitHash handler for ComponentRegistry
ponder.on(
  `MainnetComponentRegistry:UpdateUnitHash`,
  async ({ event, context }) => {
    const componentId = event.args.unitId.toString();
    const metadataJson = await memoizedFetchMetadata(
      event.args.unitHash,
      componentId,
      "component"
    );

    try {
      await context.db.update(Component, { id: componentId }).set({
        metadata: metadataJson,
        metadataHash: event.args.unitHash,
        packageHash: metadataJson?.packageHash,
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
        metadataURI: metadataJson?.metadataURI,
      });
    } catch (e) {
      // console.error("Error in UpdateUnitHash handler for Component:", e);
    }
  }
);

// Create event handlers for each contract
CONTRACT_NAMES.forEach((contractName) => {
  ponder.on(`${contractName}:CreateService`, async ({ event, context }) => {
    const chain = getChainName(contractName);
    const serviceId = event.args.serviceId.toString().toLowerCase();
    const cleanServiceId = serviceId.replace(/^service-/, "");
    const chainScopedId = createChainScopedId(chain, cleanServiceId);

    const metadataJson = await memoizedFetchMetadata(
      event.args.configHash,
      chainScopedId,
      "service"
    );
    const packageHash = metadataJson?.packageHash;

    try {
      await context.db.insert(Service).values({
        id: chainScopedId,
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
        metadataURI: metadataJson?.metadataURI,
      });
    } catch (e) {
      //if the service already exists, update it
      await context.db.update(Service, { id: chainScopedId }).set({
        metadata: metadataJson,
        metadataHash: event.args.configHash,
        packageHash,
        metadataURI: metadataJson?.metadataURI,
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
      await context.db
        .update(Service, {
          id: chainScopedId,
        })
        .set({
          state: "DEPLOYED",
        });
    } catch (e) {
      console.log("error", e);
      //
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
      // Update agent
      await context.db.update(Agent, { id: agentId }).set({
        operator: event.args.operator,
        instance: event.args.agentInstance,
      });

      // Update service state
      const service = await context.db.find(Service, { id: serviceId });
      if (service) {
        await context.db.update(Service, { id: serviceId }).set({
          state: "REGISTERED",
        });
      }

      // Create service-agent relation
      await context.db.insert(ServiceAgent).values({
        id: `${serviceId}-${agentId}`,
        serviceId,
        agentId,
      });
    } catch (e) {
      // console.error("Error in RegisterInstance handler:", e);
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
    const metadataJson = await memoizedFetchMetadata(
      event.args.configHash,
      serviceId,
      "service"
    );
    const packageHash = metadataJson?.packageHash;

    try {
      await context.db.update(Service, { id: serviceId }).set({
        metadata: metadataJson,
        metadataHash: event.args.configHash,
        packageHash,
        metadataURI: metadataJson?.metadataURI,
      });
    } catch (e) {
      // console.error("Error in UpdateService handler:", e);
    }
  });
});
