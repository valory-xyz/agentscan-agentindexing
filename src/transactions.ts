import { ponder } from "ponder:registry";
import {
  checkAndStoreAbi,
  REGISTER_NAMES,
} from "../utils";
import { processTransaction } from "../utils/transactionHandling";

const needsAbiTransaction = !!process.env.ABI_DATABASE_URL;

REGISTER_NAMES.forEach((contractName) => {
  ponder.on(`${contractName}:transaction:from`, ({ event, context }: any) => {
    void processTransaction(event.transaction.hash, event, context, true);

    if (needsAbiTransaction && event.transaction.to) {
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

    if (needsAbiTransaction && event.transaction.from) {
      void checkAndStoreAbi(
        event.transaction.from.toString(),
        context.network.chainId as any,
        context,
        BigInt(event.block.number)
      );
    }
  });
});
