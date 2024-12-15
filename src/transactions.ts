import { ponder } from "ponder:registry";
import { Transfer } from "ponder:schema";
import {
  checkAndStoreAbi,
  convertBigIntsToStrings,
  REGISTER_NAMES,
} from "../utils";

import { processTransaction } from "../utils/transactionHandling";

REGISTER_NAMES.forEach((contractName) => {
  ponder.on(`${contractName}:transaction:from`, ({ event, context }: any) => {
    void processTransaction(event.transaction.hash, event, context, true);

    if (event.transaction.to) {
      void checkAndStoreAbi(
        event.transaction.to.toString(),
        context.network.chainId as any,
        context,
        BigInt(event.block.number)
      );
    }
  });

  ponder.on(`${contractName}:transaction:to`, ({ event, context }: any) => {
    void processTransaction(event.transaction.hash, event, context, false);

    if (event.transaction.from) {
      void checkAndStoreAbi(
        event.transaction.from.toString(),
        context.network.chainId as any,
        context,
        BigInt(event.block.number)
      );
    }
  });

  ponder.on(`${contractName}:transfer:to`, async ({ event, context }) => {
    console.log(`Handling ${contractName}:transfer:to event`);
    if (!event.transaction.to) return;
    const transferId = `${event.transfer.from}-${event.transfer.to}-${event.block.number}`;

    const transferData = convertBigIntsToStrings({
      id: transferId,
      hash: event.transaction.hash,
      blockNumber: Number(event.block.number),
      timestamp: Number(event.block.timestamp),
      from: event.transfer.from.toString(),
      to: event.transfer.to.toString(),
      value: event.transaction.value,
    });
    await context.db
      .insert(Transfer)
      .values(transferData)
      .onConflictDoUpdate({
        ...transferData,
      });
    console.log(`Transfer transaction processed: ${event.transaction.hash}`);
  });

  ponder.on(`${contractName}:transfer:from`, async ({ event, context }) => {
    console.log(`Handling ${contractName}:transfer:from event`);
    if (!event.transaction.to || !event.transaction.from) return;

    const transferId = `${event.transfer.from}-${event.transfer.to}-${event.block.number}`;
    const transferData = convertBigIntsToStrings({
      id: transferId,
      hash: event.transaction.hash,
      blockNumber: Number(event.block.number),
      timestamp: Number(event.block.timestamp),
      from: event.transaction.from.toString(),
      to: event.transaction.to.toString(),
      value: event.transaction.value,
    });

    await context.db
      .insert(Transfer)
      .values(transferData)
      .onConflictDoUpdate({
        ...transferData,
      });

    console.log(`Transfer processed: ${transferId}`);
  });
});
