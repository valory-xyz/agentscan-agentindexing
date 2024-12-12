import { ponder } from "ponder:registry";
import { Transaction, Transfer, MultisendTransaction } from "ponder:schema";
import {
  checkAndStoreAbi,
  getImplementationAddress,
  isSafeTransaction,
  REGISTER_NAMES,
} from "../utils";
import axios from "axios";
import { generateEmbeddingWithRetry } from "../utils/openai";
import { pool } from "../utils/postgres";

import { decodeFunctionData } from "viem";
import { GnosisSafeABI } from "../abis/GnosisSafe";

interface MultisendTransaction {
  to: string;
  value: bigint;
  data: string;
  operation: number;
  decodedCalldata?: {
    functionName: string;
    args: any;
  } | null;
  implementationAddress?: string | null;
}

const MULTISEND_ABI = [
  {
    type: "function",
    name: "multiSend",
    inputs: [{ type: "bytes", name: "transactions" }],
  },
] as const;

async function decodeMultisendTransactions(
  data: string,
  chainId: number,
  context: any,
  blockNumber: bigint
): Promise<MultisendTransaction[]> {
  try {
    const txData = data.slice(2);
    const transactions: MultisendTransaction[] = [];
    let position = 0;

    while (position < txData.length) {
      const operation = parseInt(txData.slice(position, position + 2), 16);
      position += 2;

      let to = "0x" + txData.slice(position, position + 40);
      position += 40;

      const value = BigInt("0x" + txData.slice(position, position + 64));
      position += 64;

      const dataLength =
        parseInt(txData.slice(position, position + 64), 16) * 2;
      position += 64;

      const txnData = "0x" + txData.slice(position, position + dataLength);
      position += dataLength;

      // For delegate calls, get the implementation address
      let implementationAddress = null;
      if (operation !== 0) {
        console.log(`Getting implementation address for ${to}`);
        const implementation = await getImplementationAddress(
          to,
          chainId,
          context,
          blockNumber
        );
        console.log(
          `Got implementation address in decodeMultisendTransactions: ${implementation?.address}`
        );
        if (implementation) {
          implementationAddress = implementation.address;

          to = implementationAddress;
        }
      }

      let decodedCalldata = null;
      if (txnData !== "0x") {
        try {
          const abi = await checkAndStoreAbi(
            to,
            chainId,
            context,
            BigInt(blockNumber)
          );

          if (abi) {
            const parsedAbi = JSON.parse(abi);
            const { functionName, args } = decodeFunctionData({
              abi: parsedAbi,
              data: txnData as `0x${string}`,
            });
            decodedCalldata = { functionName, args };
          }
        } catch (error) {
          console.log(`Could not decode data for transaction to ${to}`);
        }
      }

      transactions.push({
        operation,
        to,
        value,
        data: txnData,
        decodedCalldata,
        implementationAddress,
      });
    }

    console.log("Decoded multisend transactions:", transactions.length);

    return transactions;
  } catch (error) {
    console.error("Error decoding multisend transactions:", error);
    return [];
  }
}

async function decodeSafeTransaction(
  input: string,
  chainId: number,
  context: any,
  blockNumber: bigint
): Promise<any | null> {
  try {
    const { functionName, args } = decodeFunctionData({
      abi: GnosisSafeABI,
      data: input as `0x${string}`,
    });

    if (functionName === "execTransaction") {
      const transaction = {
        to: args[0],
        value: args[1],
        data: args[2],
        operation: args[3],
        safeTxGas: args[4],
        baseGas: args[5],
        gasPrice: args[6],
        gasToken: args[7],
        refundReceiver: args[8],
        signatures: args[9],
      };

      // Check if this is a multisend transaction
      if (transaction.data.length > 2) {
        try {
          const { functionName: multiSendFn, args: multiSendArgs } =
            decodeFunctionData({
              abi: MULTISEND_ABI,
              data: transaction.data as `0x${string}`,
            });

          if (
            multiSendFn === "multiSend" &&
            multiSendArgs &&
            multiSendArgs[0]
          ) {
            // Extract the actual transactions data from the multiSend args
            const multiSendTransactions = await decodeMultisendTransactions(
              multiSendArgs[0] as any, // This is the bytes parameter containing the transactions
              chainId,
              context,
              blockNumber
            );

            console.log(
              "Multisend containing transactions:",
              multiSendTransactions.length
            );

            // Log each inner transaction
            multiSendTransactions.forEach((tx, index) => {
              console.log(`Multisend Transaction ${index + 1}:`, {
                to: tx.to,
                value: tx.value.toString(),
                valueInEth: Number(tx.value) / 1e18 + " ETH", // Convert to ETH
                operation: tx.operation === 0 ? "Call" : "DelegateCall",
                decodedFunction: tx.decodedCalldata
                  ? {
                      name: tx.decodedCalldata.functionName,
                      args: tx.decodedCalldata.args,
                      rawData: tx.data,
                    }
                  : "Unable to decode",
                implementationAddress: tx.implementationAddress || undefined,
              });
            });

            return {
              ...transaction,
              multiSendTransactions,
            };
          }
        } catch (error) {
          console.error("Error decoding multisend:", error);
        }
      }

      return transaction;
    }
    return null;
  } catch (error) {
    console.error("Error decoding Safe transaction:", error);
    return null;
  }
}

async function processTransaction(event: any, context: any) {
  try {
    const fromAddress = event.transaction.from.toString();
    const toAddress = event.transaction.to?.toString();
    const input = event.transaction.input;

    let decodedFunction = null;
    if (input && input !== "0x" && toAddress) {
      try {
        const abi = await checkAndStoreAbi(
          toAddress,
          context.network.chainId,
          context,
          BigInt(event.block.number)
        );

        if (abi) {
          const { functionName, args } = decodeFunctionData({
            abi: JSON.parse(abi),
            data: input as `0x${string}`,
          });
          decodedFunction = JSON.stringify({ functionName, args });
        }
      } catch (error) {
        console.log(
          `Could not decode function data for transaction ${event.transaction.hash}`
        );
      }
    }

    const safeTransaction = await decodeSafeTransaction(
      input,
      context.network.chainId,
      context,
      event.block.number
    );

    const transactionData = {
      hash: event.transaction.hash,
      blockNumber: Number(event.block.number),
      timestamp: Number(event.block.timestamp),
      from: fromAddress,
      to: toAddress || "",
      value: BigInt(event.transaction.value),
      input: input,
      isMultisend: safeTransaction?.multiSendTransactions?.length > 0,
      decodedData: safeTransaction ? JSON.stringify(safeTransaction) : null,
      decodedFunction: decodedFunction,
    };

    await context.db
      .insert(Transaction)
      .values(transactionData)
      .onConflictDoUpdate({
        ...transactionData,
      });

    if (safeTransaction) {
      const isMultisend = safeTransaction.multiSendTransactions?.length > 0;

      if (isMultisend) {
        for (
          let i = 0;
          i < safeTransaction.multiSendTransactions!.length;
          i++
        ) {
          const tx = safeTransaction.multiSendTransactions![i];
          const multisendTx = {
            id: `${event.transaction.hash}-${i}`,
            hash: event.transaction.hash,
            from: fromAddress,
            to: tx.to,
            value: tx.value,
            data: tx.data,
            operation: tx.operation,
            decodedFunction: tx.decodedCalldata
              ? JSON.stringify(tx.decodedCalldata)
              : null,
            implementationAddress: tx.implementationAddress || null,
            index: i,
          };

          const { id, ...updateFields } = multisendTx;

          await context.db
            .insert(MultisendTransaction)
            .values(multisendTx)
            .onConflictDoUpdate({
              ...updateFields,
              operation: tx.operation,
            });
        }
      }

      console.log(
        `Processed Safe transaction${
          isMultisend
            ? ` with ${
                safeTransaction.multiSendTransactions!.length
              } inner transactions`
            : ""
        }: ${event.transaction.hash}`
      );
    }
  } catch (error: any) {
    console.error(`Failed to process transaction: ${error.message}`);
  }
}

REGISTER_NAMES.forEach((contractName) => {
  ponder.on(
    `${contractName}:transaction:from`,
    async ({ event, context }: any) => {
      await processTransaction(event, context);

      if (event.transaction.to) {
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
      console.log(`Handling ${contractName}:transaction:to event`);
      await processTransaction(event, context);

      if (event.transaction.from) {
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
