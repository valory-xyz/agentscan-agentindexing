import { onchainTable, onchainEnum, index, relations } from "@ponder/core";

export const ServiceState = onchainEnum("state", [
  "UNREGISTERED",
  "REGISTERED",
  "DEPLOYED",
  "AGENT_INSTANCES",
  "ACTIVE",
  "TERMINATED",
]);

export const Service = onchainTable(
  "service",
  (t) => ({
    id: t.text().primaryKey(),
    chain: t.text().notNull(),
    securityDeposit: t.bigint().notNull(),
    multisig: t.hex().notNull(),
    threshold: t.integer().notNull(),
    maxNumAgentInstances: t.integer().notNull(),
    numAgentInstances: t.integer().notNull(),
    state: ServiceState("state").notNull(),
    blockNumber: t.integer().notNull(),
    timestamp: t.integer().notNull(),
    metadata: t.json(),
    chainId: t.integer().notNull(),
    packageHash: t.text(),
    metadataHash: t.text(),
  }),
  (table) => ({
    idx: index().on(table.id),
    chainIdx: index().on(table.chain),
    packageHashIdx: index().on(table.packageHash),
    metadataHashIdx: index().on(table.metadataHash),
  })
);

export const Agent = onchainTable(
  "agent",
  (t) => ({
    id: t.text().primaryKey(),
    instance: t.text().notNull(),
    metadata: t.json(),
    blockNumber: t.integer().notNull(),
    timestamp: t.integer().notNull(),
    metadataHash: t.text(),
    metadataURI: t.text(),
    packageHash: t.text(),
  }),
  (table) => ({
    idx: index().on(table.id),
    instanceIdx: index().on(table.instance),
    packageHashIdx: index().on(table.packageHash),
    metadataHashIdx: index().on(table.metadataHash),
  })
);

export const Component = onchainTable(
  "component",
  (t) => ({
    id: t.text().primaryKey(),
    instance: t.text().notNull(),
    metadata: t.json(),
    blockNumber: t.integer().notNull(),
    timestamp: t.integer().notNull(),
    metadataHash: t.text(),
    metadataURI: t.text(),
    packageHash: t.text(),
  }),
  (table) => ({
    idx: index().on(table.id),
    instanceIdx: index().on(table.instance),
    packageHashIdx: index().on(table.packageHash),
    metadataHashIdx: index().on(table.metadataHash),
  })
);

// Relations

export const ServiceAgent = onchainTable("service_agent", (t) => ({
  id: t.text().primaryKey(),
  serviceId: t.text().notNull(),
  agentId: t.text().notNull(),
}));

export const ServiceAgentRelations = relations(ServiceAgent, ({ one }) => ({
  service: one(Service, {
    fields: [ServiceAgent.serviceId],
    references: [Service.id],
  }),
  agent: one(Agent, {
    fields: [ServiceAgent.agentId],
    references: [Agent.id],
  }),
}));

// Add these relations for Service and Agent
export const ServiceRelations = relations(Service, ({ many }) => ({
  serviceAgents: many(ServiceAgent),
}));

export const AgentRelations = relations(Agent, ({ many }) => ({
  serviceAgents: many(ServiceAgent),
}));

export const ComponentAgent = onchainTable("component_agent", (t) => ({
  id: t.text().primaryKey(),
  componentId: t.text().notNull(),
  agentId: t.text().notNull(),
}));

export const ComponentRelations = relations(Component, ({ many }) => ({
  agentComponents: many(ComponentAgent),
}));

export const AgentComponentRelations = relations(Agent, ({ many }) => ({
  componentAgents: many(ComponentAgent),
}));

export const ComponentAgentRelations = relations(ComponentAgent, ({ one }) => ({
  component: one(Component, {
    fields: [ComponentAgent.componentId],
    references: [Component.id],
  }),
  agent: one(Agent, {
    fields: [ComponentAgent.agentId],
    references: [Agent.id],
  }),
}));
