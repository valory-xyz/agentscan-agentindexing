import { ponder } from "ponder:registry";
import { Transaction, Transfer } from "ponder:schema";
import { REGISTER_NAMES } from "../utils";

REGISTER_NAMES.forEach((contractName) => {
  ponder.on(`${contractName}:transaction:from`, async ({ event, context }) => {
    console.log(`Handling ${contractName}:transaction:from event`);

    const transactionData = {
      hash: event.transaction.hash,
      blockNumber: Number(event.block.number),
      timestamp: Number(event.block.timestamp),
      from: event.transaction.from.toString(),
      to: event.transaction.to ? event.transaction.to.toString() : "",
      value: BigInt(event.transaction.value),
      input: event.transaction.input,
    };

    await context.db
      .insert(Transaction)
      .values(transactionData)
      .onConflictDoUpdate({
        ...transactionData,
      });

    console.log(`Transaction processed: ${event.transaction.hash}`);
  });

  ponder.on(`${contractName}:transaction:to`, async ({ event, context }) => {
    console.log(`Handling ${contractName}:transaction:to event`);

    const transactionData = {
      hash: event.transaction.hash,
      blockNumber: Number(event.block.number),
      timestamp: Number(event.block.timestamp),
      from: event.transaction.from.toString(),
      to: event.transaction.to ? event.transaction.to.toString() : "",
      value: BigInt(event.transaction.value),
      input: event.transaction.input,
    };

    await context.db
      .insert(Transaction)
      .values(transactionData)
      .onConflictDoUpdate({
        ...transactionData,
      });

    console.log(`Transaction processed: ${event.transaction.hash}`);
  });

  ponder.on(`${contractName}:transfer:to`, async ({ event, context }) => {
    console.log(`Handling ${contractName}:transfer:to event`);

    if (!event.transaction.to) return;

    const transactionData = {
      hash: event.transaction.hash,
      blockNumber: Number(event.block.number),
      timestamp: Number(event.block.timestamp),
      from: event.transaction.from.toString(),
      to: event.transaction.to.toString(),
      value: BigInt(event.transaction.value),
      input: event.transaction.input,
    };

    await context.db
      .insert(Transaction)
      .values(transactionData)
      .onConflictDoUpdate({
        ...transactionData,
      });

    console.log(`Transfer transaction processed: ${event.transaction.hash}`);
  });

  ponder.on(`${contractName}:transfer:from`, async ({ event, context }) => {
    console.log(`Handling ${contractName}:transfer:from event`);

    if (!event.transaction.to || !event.transaction.from) return;

    const transferId = `${event.transfer.from}-${event.transfer.to}-${event.block.number}`;
    const transferData = {
      id: transferId,
      hash: event.transaction.hash,
      blockNumber: Number(event.block.number),
      timestamp: Number(event.block.timestamp),
      from: event.transaction.from.toString(),
      to: event.transaction.to.toString(),
      value: BigInt(event.transaction.value),
    };

    await context.db
      .insert(Transfer)
      .values(transferData)
      .onConflictDoUpdate({
        ...transferData,
      });

    console.log(`Transfer processed: ${transferId}`);
  });
});
