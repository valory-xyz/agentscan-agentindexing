import { ponder } from "ponder:registry";

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
});
