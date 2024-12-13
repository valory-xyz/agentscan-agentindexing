import { ponder } from "ponder:registry";
import { Transfer } from "ponder:schema";
import { checkAndStoreAbi, REGISTER_NAMES } from "../utils";

import { processTransaction } from "../utils/transactionHandling";

REGISTER_NAMES.forEach((contractName) => {
  ponder.on(
    `${contractName}:transaction:from`,
    async ({ event, context }: any) => {
      await processTransaction(event.transaction.hash, event, context, true);

      if (event.transaction.to) {
        console.log(
          `Checking ABI for ${event.transaction.to} in processTransaction`
        );
        await checkAndStoreAbi(
          event.transaction.to.toString(),
          context.network.chainId as any,
          context,
          BigInt(event.block.number)
        );
      }

      console.log(`Transaction processed: ${event.transaction.hash}`);
    }
  );

  ponder.on(
    `${contractName}:transaction:to`,
    async ({ event, context }: any) => {
      await processTransaction(event.transaction.hash, event, context, false);

      if (event.transaction.from) {
        console.log(
          `Checking ABI for ${event.transaction.from} in processTransaction`
        );
        await checkAndStoreAbi(
          event.transaction.from.toString(),
          context.network.chainId as any,
          context,
          BigInt(event.block.number)
        );
      }
      console.log(`Transaction processed: ${event.transaction.hash}`);
    }
  );

  ponder.on(`${contractName}:transfer:to`, async ({ event, context }) => {
    console.log(`Handling ${contractName}:transfer:to event`);
    if (!event.transaction.to) return;
    const transferId = `${event.transfer.from}-${event.transfer.to}-${event.block.number}`;

    const transferData = {
      id: transferId,
      hash: event.transaction.hash,
      blockNumber: Number(event.block.number),
      timestamp: Number(event.block.timestamp),
      from: event.transfer.from.toString(),
      to: event.transfer.to.toString(),
      value: BigInt(event.transaction.value),
    };
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
