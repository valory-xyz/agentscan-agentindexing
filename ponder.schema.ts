import { onchainTable, onchainEnum, index, relations } from "@ponder/core";

export const ServiceState = onchainEnum("state", [
  "UNREGISTERED",
  "REGISTERED",
  "DEPLOYED",
  "AGENT_INSTANCES",
  "ACTIVE",
  "TERMINATED",
]);

export const Service = onchainTable("service", (t) => ({
  id: t.text().primaryKey(),
  chain: t.text().notNull(),
  owner: t.hex().notNull(),
  securityDeposit: t.bigint().notNull(),
  multisig: t.hex().notNull(),
  configHash: t.text().notNull(),
  threshold: t.integer().notNull(),
  maxNumAgentInstances: t.integer().notNull(),
  numAgentInstances: t.integer().notNull(),
  state: ServiceState("state").notNull(),
  blockNumber: t.integer().notNull(),
  timestamp: t.integer().notNull(),
  metadata: t.json(),
}));

export const ServiceRelations = relations(Service, ({ many }) => ({
  agentInstances: many(AgentInstance),
}));

export const AgentInstance = onchainTable(
  "agent_instance",
  (t) => ({
    id: t.text().primaryKey(),
    chain: t.text().notNull(),
    serviceId: t.text().notNull(),
    operator: t.hex().notNull(),
    agentId: t.integer().notNull(),
    instance: t.text().notNull(),
    blockNumber: t.integer().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({
    serviceIdx: index().on(table.serviceId),
  })
);

export const AgentInstanceRelations = relations(AgentInstance, ({ one }) => ({
  service: one(Service, {
    fields: [AgentInstance.serviceId],
    references: [Service.id],
  }),
}));

export const OperatorBalance = onchainTable("operator_balance", (t) => ({
  id: t.text().primaryKey(),
  chain: t.text().notNull(),
  operator: t.hex().notNull(),
  serviceId: t.text().notNull(),
  balance: t.bigint().notNull(),
  blockNumber: t.integer().notNull(),
  timestamp: t.integer().notNull(),
}));

export const SlashEvent = onchainTable("slash_event", (t) => ({
  id: t.text().primaryKey(),
  chain: t.text().notNull(),
  operator: t.hex().notNull(),
  serviceId: t.text().notNull(),
  amount: t.bigint().notNull(),
  blockNumber: t.integer().notNull(),
  timestamp: t.integer().notNull(),
}));

export const ServiceRegistrationEvent = onchainTable(
  "service_registration_event",
  (t) => ({
    id: t.text().primaryKey(),
    chain: t.text().notNull(),
    serviceId: t.text().notNull(),
    configHash: t.text().notNull(),
    blockNumber: t.integer().notNull(),
    timestamp: t.integer().notNull(),
  })
);

export const ServiceDeploymentEvent = onchainTable(
  "service_deployment_event",
  (t) => ({
    id: t.text().primaryKey(),
    chain: t.text().notNull(),
    serviceId: t.text().notNull(),
    multisig: t.hex().notNull(),
    blockNumber: t.integer().notNull(),
    timestamp: t.integer().notNull(),
  })
);

export const ServiceTerminationEvent = onchainTable(
  "service_termination_event",
  (t) => ({
    id: t.text().primaryKey(),
    chain: t.text().notNull(),
    serviceId: t.text().notNull(),
    refund: t.bigint().notNull(),
    blockNumber: t.integer().notNull(),
    timestamp: t.integer().notNull(),
  })
);

export const MultisigTransaction = onchainTable(
  "multisig_transaction",
  (t) => ({
    id: t.text().primaryKey(),
    chain: t.text().notNull(),
    serviceId: t.text().notNull(),
    multisig: t.hex().notNull(),
    hash: t.text().notNull(),
    from: t.hex().notNull(),
    to: t.hex().notNull(),
    value: t.bigint().notNull(),
    data: t.text().notNull(),
    blockNumber: t.integer().notNull(),
    timestamp: t.integer().notNull(),
  })
);

export const AgentInstanceTransaction = onchainTable(
  "agent_instance_transaction",
  (t) => ({
    id: t.text().primaryKey(),
    chain: t.text().notNull(),
    serviceId: t.text().notNull(),
    agentInstance: t.text().notNull(),
    hash: t.text().notNull(),
    from: t.hex().notNull(),
    to: t.hex().notNull(),
    value: t.bigint().notNull(),
    data: t.text().notNull(),
    blockNumber: t.integer().notNull(),
    timestamp: t.integer().notNull(),
  })
);

export const LastCheckedBlock = onchainTable("last_checked_block", (t) => ({
  id: t.text().primaryKey(),
  blockNumber: t.integer().notNull(),
  timestamp: t.integer().notNull(),
}));
