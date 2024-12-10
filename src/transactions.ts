import { ponder } from "ponder:registry";
import { Transaction, Transfer } from "ponder:schema";
import { REGISTER_NAMES } from "../utils";

REGISTER_NAMES.forEach((contractName) => {
  ponder.on(`${contractName}:transaction:from`, async ({ event, context }) => {
    console.log("transaction from", event);
    try {
      await context.db.insert(Transaction).values({
        id: event.transaction.hash,
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
        from: event.transaction.from.toString(),
        to: event.transaction.to ? event.transaction.to.toString() : "",
        value: BigInt(event.transaction.value),
        hash: event.transaction.hash,
      });
    } catch (e) {
      console.error("Error in InstanceTransaction handler:", e);
    }
  });

  ponder.on(`${contractName}:transaction:to`, async ({ event, context }) => {
    console.log("transaction to", event);
    try {
      await context.db.insert(Transaction).values({
        id: event.transaction.hash,
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
        from: event.transaction.from.toString(),
        to: event.transaction.to ? event.transaction.to.toString() : "",
        value: BigInt(event.transaction.value),
        hash: event.transaction.hash,
      });
    } catch (e) {
      console.error("Error in InstanceTransaction handler:", e);
    }
  });

  ponder.on(`${contractName}:transfer:to`, async ({ event, context }) => {
    console.log("transfer to", event);
    const transferId = `${event.transfer.from}-${event.transfer.to}-${event.block.number}`;
    try {
      if (event.transaction.to) {
        await context.db.insert(Transfer).values({
          id: transferId,
          hash: event.transaction.hash,
          blockNumber: Number(event.block.number),
          timestamp: Number(event.block.timestamp),
          from: event.transaction.from.toString(),
          to: event.transaction.to?.toString(),
          value: BigInt(event.transaction.value),
        });
      }
    } catch (e) {
      console.error("Error in Transfer handler:", e);
    }
  });

  ponder.on(`${contractName}:transfer:from`, async ({ event, context }) => {
    console.log("transfer from", event);
    try {
      const transferId = `${event.transfer.from}-${event.transfer.to}-${event.block.number}`;

      if (event.transaction.to && event.transaction.from) {
        await context.db.insert(Transfer).values({
          id: transferId,
          hash: event.transaction.hash,
          blockNumber: Number(event.block.number),
          timestamp: Number(event.block.timestamp),
          from: event.transaction.from.toString(),
          to: event.transaction.to.toString(),
          value: BigInt(event.transaction.value),
        });
      }
    } catch (e) {
      console.error("Error in Transfer handler:", e);
    }
  });
});
