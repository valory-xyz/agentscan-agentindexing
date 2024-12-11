import { ponder } from "ponder:registry";
import {
  Service,
  Agent,
  ServiceAgent,
  ComponentAgent,
  AgentInstance,
} from "ponder:schema";
import {
  CONTRACT_NAMES,
  createChainScopedId,
  fetchMetadata,
  getChainId,
  getChainName,
} from "../utils";

const createDefaultService = (
  serviceId: string,
  chain: string,
  blockNumber: number,
  timestamp: number,
  configHash?: string | null
) => ({
  id: serviceId,
  chain,
  securityDeposit: 0n,
  multisig: "0x" as `0x${string}`,
  configHash,
  threshold: 0,
  maxNumAgentInstances: 0,
  numAgentInstances: 0,
  state: "UNREGISTERED" as const,
  blockNumber,
  chainId: getChainId(chain),
  name: null,
  description: null,
  image: null,
  codeUri: null,
  metadataURI: null,
  packageHash: null,
  metadataHash: configHash,
  timestamp,
});

ponder.on(`MainnetAgentRegistry:CreateUnit`, async ({ event, context }) => {
  const agentId = event.args.unitId.toString();
  console.log(`Handling MainnetAgentRegistry:CreateUnit for agent ${agentId}`);
  const [metadataJson] = await Promise.all([
    fetchMetadata(event.args.unitHash, agentId, "agent"),
  ]);

  if (!metadataJson) {
    console.warn(`No metadata found for agent ${agentId}`);
    return;
  }

  const updateData = {
    name: metadataJson.name,
    description: metadataJson.description,
    image: metadataJson.image,
    codeUri: metadataJson.codeUri,
    blockNumber: Number(event.block.number),
    timestamp: Number(event.block.timestamp),
    packageHash: metadataJson.packageHash,
    metadataHash: event.args.unitHash,
    metadataURI: metadataJson.metadataURI,
  };

  await context.db
    .insert(Agent)
    .values({
      id: agentId,
      ...updateData,
    })
    .onConflictDoUpdate({
      ...updateData,
      timestamp: Number(event.block.timestamp),
    });

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
});

ponder.on(`MainnetAgentRegistry:Transfer`, async ({ event, context }) => {
  const agentId = event.args.id.toString();
  console.log(`Handling MainnetAgentRegistry:Transfer for agent ${agentId}`);

  try {
    console.log(`Updating operator for agent ${agentId}`);
    await context.db.update(Agent, { id: agentId }).set({
      operator: event.args.to.toString(),
    });
  } catch (e) {
    console.error("Error in AgentRegistry:Transfer:", e);
    try {
      await context.db
        .insert(Agent)
        .values({
          id: agentId,
          operator: event.args.to.toString(),
          name: null,
          description: null,
          image: null,
          codeUri: null,
          blockNumber: Number(event.block.number),
          timestamp: Number(event.block.timestamp),
          packageHash: null,
          metadataHash: null,
          metadataURI: null,
        })
        .onConflictDoNothing();
    } catch (e) {
      console.error("Error inserting new agent:", e);
    }
  }
});

// ponder.on(`MainnetComponentRegistry:CreateUnit`, async ({ event, context }) => {
//   const componentId = event.args.unitId.toString();
//   console.log(
//     `Handling MainnetComponentRegistry:CreateUnit for component ${componentId}`
//   );
//   const [metadataJson] = await Promise.all([
//     fetchMetadata(event.args.unitHash, componentId, "component", true),
//   ]);

//   const componentData = {
//     id: componentId,
//     instance: "0x",
//     name: metadataJson?.name,
//     description: metadataJson?.description,
//     image: metadataJson?.image,
//     codeUri: metadataJson?.codeUri,
//     blockNumber: Number(event.block.number),
//     timestamp: Number(event.block.timestamp),
//     packageHash: metadataJson?.packageHash,
//     metadataHash: event.args.unitHash,
//     metadataURI: metadataJson?.metadataURI,
//   };

//   await context.db
//     .insert(Component)
//     .values(componentData)
//     .onConflictDoUpdate({
//       ...componentData,
//       timestamp: Number(event.block.timestamp),
//     });

//   try {
//     const { client } = context;

//     const { MainnetComponentRegistry } = context.contracts;
//     const dependencies = await client.readContract({
//       abi: MainnetComponentRegistry.abi,
//       address: MainnetComponentRegistry.address,
//       functionName: "getDependencies",
//       args: [event.args.unitId],
//     });

//     if (
//       dependencies &&
//       Array.isArray(dependencies) &&
//       dependencies.length === 2
//     ) {
//       const dependencyArray = dependencies[1];
//       if (Array.isArray(dependencyArray) && dependencyArray.length > 0) {
//         const validDependencies = dependencyArray
//           .map((dep) => dep.toString())
//           .filter((dep) => dep !== "")
//           .map((dependency) => ({
//             id: `${componentId}-${dependency}`,
//             componentId,
//             dependencyId: dependency,
//           }));

//         if (validDependencies.length > 0) {
//           console.log(`Inserting dependencies for component ${componentId}`);
//           await context.db
//             .insert(ComponentDependency)
//             .values(validDependencies)
//             .onConflictDoNothing();
//         }
//       }
//     }
//   } catch (e) {
//     console.error("Error processing dependencies for component:", e);
//   }
// });

// ponder.on(`MainnetComponentRegistry:Transfer`, async ({ event, context }) => {
//   const componentId = event.args.id.toString();
//   console.log(
//     `Handling MainnetComponentRegistry:Transfer for component ${componentId}`
//   );

//   try {
//     console.log(`Updating instance for component ${componentId}`);
//     await context.db
//       .update(Component, {
//         id: componentId,
//       })
//       .set({
//         instance: event.args.to,
//       });
//   } catch (e) {
//     console.error("Error in ComponentRegistry:Transfer:", e);
//     try {
//       await context.db.insert(Component).values({
//         id: componentId,
//         instance: event.args.to,
//         blockNumber: Number(event.block.number),
//         timestamp: Number(event.block.timestamp),
//       });
//     } catch (e) {
//       console.error("Error inserting new component:", e);
//     }
//   }
// });

ponder.on(`MainnetAgentRegistry:UpdateUnitHash`, async ({ event, context }) => {
  const agentId = event.args.unitId.toString();
  console.log(
    `Handling MainnetAgentRegistry:UpdateUnitHash for agent ${agentId}`
  );

  const metadataJson = await fetchMetadata(
    event.args.unitHash,
    agentId,
    "agent"
  );

  try {
    console.log(`Updating metadata for agent ${agentId}`);
    await context.db.update(Agent, { id: agentId }).set({
      blockNumber: Number(event.block.number),
      timestamp: Number(event.block.timestamp),
      packageHash: metadataJson?.packageHash,
      metadataHash: event.args.unitHash,
      metadataURI: metadataJson?.metadataURI,
      name: metadataJson?.name,
      description: metadataJson?.description,
      image: metadataJson?.image,
      codeUri: metadataJson?.codeUri,
    });
  } catch (e) {
    console.error("Error in UpdateUnitHash handler for Agent:", e);
  }
});

// ponder.on(
//   `MainnetComponentRegistry:UpdateUnitHash`,
//   async ({ event, context }) => {
//     const componentId = event.args.unitId.toString();
//     console.log(
//       `Handling MainnetComponentRegistry:UpdateUnitHash for component ${componentId}`
//     );

//     const metadataJson = await fetchMetadata(
//       event.args.unitHash,
//       componentId,
//       "component",
//       false
//     );

//     try {
//       console.log(`Updating metadata for component ${componentId}`);
//       await context.db.update(Component, { id: componentId }).set({
//         blockNumber: Number(event.block.number),
//         timestamp: Number(event.block.timestamp),
//         packageHash: metadataJson?.packageHash,
//         metadataHash: event.args.unitHash,
//         metadataURI: metadataJson?.metadataURI,
//         name: metadataJson?.name,
//         description: metadataJson?.description,
//         image: metadataJson?.image,
//         codeUri: metadataJson?.codeUri,
//       });
//     } catch (e) {
//       console.error("Error in UpdateUnitHash handler for Component:", e);
//     }
//   }
// );

CONTRACT_NAMES.forEach((contractName) => {
  ponder.on(`${contractName}:CreateService`, async ({ event, context }) => {
    const chain = getChainName(contractName);

    const serviceId = createChainScopedId(
      chain,
      event.args.serviceId.toString().toLowerCase()
    );

    const metadataJson = await fetchMetadata(
      event.args.configHash,
      serviceId,
      "service"
    );
    const packageHash = metadataJson?.packageHash;
    console.log(
      `Handling ${contractName}:CreateService for service ${serviceId}`
    );

    const serviceData = {
      id: serviceId,
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
      name: metadataJson?.name,
      description: metadataJson?.description,
      image: metadataJson?.image,
      codeUri: metadataJson?.codeUri,
      metadataURI: metadataJson?.metadataURI,
      packageHash,
      metadataHash: event.args.configHash,
      timestamp: Number(event.block.timestamp),
    };
    try {
      console.log(`Inserting service ${serviceId}`);
      await context.db
        .insert(Service)
        .values({
          ...serviceData,
          multisig: serviceData.multisig as `0x${string}`,
        })
        .onConflictDoNothing();
    } catch (e) {
      console.error(
        `Error inserting service ${serviceId}, attempting update`,
        e
      );
      await context.db.update(Service, { id: serviceId }).set({
        ...serviceData,
        multisig: serviceData.multisig as `0x${string}`,
      });
    }
  });

  ponder.on(`${contractName}:DeployService`, async ({ event, context }) => {
    const chain = getChainName(contractName);
    const serviceId = createChainScopedId(
      chain,
      event.args.serviceId.toString().toLowerCase()
    );
    console.log(
      `Handling ${contractName}:DeployService for service ${serviceId}`
    );

    try {
      await context.db
        .update(Service, { id: serviceId })
        .set({ state: "DEPLOYED" });
    } catch (e) {
      console.error("Error updating service, attempting creation:", e);
      try {
        const defaultService = createDefaultService(
          serviceId,
          chain,
          Number(event.block.number),
          Number(event.block.timestamp)
        );
        await context.db
          .insert(Service)
          .values({ ...defaultService, state: "DEPLOYED" })
          .onConflictDoUpdate({ state: "DEPLOYED" });
      } catch (insertError) {
        console.error("Error in DeployService fallback handler:", insertError);
      }
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
        await context.db
          .update(Service, { id: serviceId })
          .set({ multisig: event.args.multisig });
      } catch (e) {
        console.error("Error updating service, attempting creation:", e);
        try {
          const defaultService = createDefaultService(
            serviceId,
            chain,
            Number(event.block.number),
            Number(event.block.timestamp)
          );
          await context.db
            .insert(Service)
            .values({ ...defaultService, multisig: event.args.multisig })
            .onConflictDoUpdate({ multisig: event.args.multisig });
        } catch (insertError) {
          console.error(
            "Error in CreateMultisigWithAgents fallback handler:",
            insertError
          );
        }
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
      await context.db
        .insert(AgentInstance)
        .values({
          id: event.args.agentInstance,
          agentId: agentId,
          serviceId: serviceId,
          blockNumber: Number(event.block.number),
          timestamp: Number(event.block.timestamp),
        })
        .onConflictDoNothing();
      try {
        await context.db
          .update(Service, { id: serviceId })
          .set({ state: "REGISTERED" });
      } catch (e) {
        console.error("Error updating service, attempting creation:", e);
        try {
          const defaultService = createDefaultService(
            serviceId,
            chain,
            Number(event.block.number),
            Number(event.block.timestamp)
          );
          await context.db
            .insert(Service)
            .values({ ...defaultService, state: "REGISTERED" })
            .onConflictDoUpdate({ state: "REGISTERED" });
        } catch (insertError) {
          console.error(
            "Error in RegisterInstance fallback handler:",
            insertError
          );
        }
      }
      await context.db
        .insert(ServiceAgent)
        .values({
          id: `${serviceId}-${event.args.agentInstance}`,
          serviceId,
          agentInstanceId: event.args.agentInstance,
        })
        .onConflictDoNothing();
    } catch (e) {
      console.error("Error updating service, attempting creation:", e);
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
      await context.db
        .update(Service, { id: serviceId })
        .set({ state: "TERMINATED" });
    } catch (e) {
      console.error("Error updating service, attempting creation:", e);
      try {
        const defaultService = createDefaultService(
          serviceId,
          chain,
          Number(event.block.number),
          Number(event.block.timestamp)
        );
        await context.db
          .insert(Service)
          .values({ ...defaultService, state: "TERMINATED" })
          .onConflictDoUpdate({ state: "TERMINATED" });
      } catch (insertError) {
        console.error(
          "Error in TerminateService fallback handler:",
          insertError
        );
      }
    }
  });

  ponder.on(`${contractName}:UpdateService`, async ({ event, context }) => {
    const chain = getChainName(contractName);
    const serviceId = createChainScopedId(
      chain,
      event.args.serviceId.toString().toLowerCase()
    );
    console.log(
      `Handling ${contractName}:UpdateService for service ${serviceId}`
    );

    try {
      const metadataJson = await fetchMetadata(
        event.args.configHash,
        serviceId,
        "service"
      );
      const packageHash = metadataJson?.packageHash;
      await context.db.update(Service, { id: serviceId }).set({
        metadataURI: metadataJson?.metadataURI,
        packageHash,
        metadataHash: event.args.configHash,
        name: metadataJson?.name,
        description: metadataJson?.description,
        image: metadataJson?.image,
        codeUri: metadataJson?.codeUri,
      });
    } catch (e) {
      console.error("Error updating service, attempting creation:", e);
      try {
        const defaultService = createDefaultService(
          serviceId,
          chain,
          Number(event.block.number),
          Number(event.block.timestamp),
          event.args.configHash
        );
        await context.db
          .insert(Service)
          .values({
            ...defaultService,
          })
          .onConflictDoUpdate({
            metadataHash: event.args.configHash,
          });
      } catch (insertError) {
        console.error("Error in UpdateService fallback handler:", insertError);
      }
    }
  });
});
