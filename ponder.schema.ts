import { createSchema } from "@ponder/core";

export default createSchema((p) => ({
  Service: p.createTable({
    id: p.string(),
    chain: p.string(),
    owner: p.string(),
    securityDeposit: p.bigint(),
    multisig: p.string(),
    configHash: p.string(),
    threshold: p.int(),
    maxNumAgentInstances: p.int(),
    numAgentInstances: p.int(),
    state: p.int(),
    blockNumber: p.int(),
    timestamp: p.int(),
    metadata: p.json().optional(),
  }),

  AgentInstance: p.createTable({
    id: p.string(),
    chain: p.string(),
    serviceId: p.string(),
    operator: p.string(),
    agentId: p.int(),
    instance: p.string(),
    blockNumber: p.int(),
    timestamp: p.int(),
  }),

  OperatorBalance: p.createTable({
    id: p.string(),
    chain: p.string(),
    operator: p.string(),
    serviceId: p.string(),
    balance: p.bigint(),
    blockNumber: p.int(),
    timestamp: p.int(),
  }),

  SlashEvent: p.createTable({
    id: p.string(),
    chain: p.string(),
    operator: p.string(),
    serviceId: p.string(),
    amount: p.bigint(),
    blockNumber: p.int(),
    timestamp: p.int(),
  }),

  ServiceRegistrationEvent: p.createTable({
    id: p.string(),
    chain: p.string(),
    serviceId: p.string(),
    configHash: p.string(),
    blockNumber: p.int(),
    timestamp: p.int(),
  }),

  ServiceDeploymentEvent: p.createTable({
    id: p.string(),
    chain: p.string(),
    serviceId: p.string(),
    multisig: p.string(),
    blockNumber: p.int(),
    timestamp: p.int(),
  }),

  ServiceTerminationEvent: p.createTable({
    id: p.string(),
    chain: p.string(),
    serviceId: p.string(),
    refund: p.bigint(),
    blockNumber: p.int(),
    timestamp: p.int(),
  }),

  MultisigTransaction: p.createTable({
    id: p.string(),
    chain: p.string(),
    serviceId: p.string(),
    multisig: p.string(),
    hash: p.string(),
    from: p.string(),
    to: p.string(),
    value: p.bigint(),
    data: p.string(),
    blockNumber: p.int(),
    timestamp: p.int(),
  }),

  AgentInstanceTransaction: p.createTable({
    id: p.string(),
    chain: p.string(),
    serviceId: p.string(),
    agentInstance: p.string(),
    hash: p.string(),
    from: p.string(),
    to: p.string(),
    value: p.bigint(),
    data: p.string(),
    blockNumber: p.int(),
    timestamp: p.int(),
  }),

  LastCheckedBlock: p.createTable({
    id: p.string(),
    blockNumber: p.int(),
    timestamp: p.int(),
  }),
}));
