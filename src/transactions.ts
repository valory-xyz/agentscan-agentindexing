import { ponder } from "ponder:registry";
import {
  Transaction,
  Transfer,
  MultisendTransaction,
  AgentFromTransaction,
  AgentToTransaction,
} from "ponder:schema";
import {
  checkAndStoreAbi,
  convertBigIntsToStrings,
  decodeTokenTransfer,
  getImplementationAddress,
  processArgs,
  REGISTER_NAMES,
  TokenTransferData,
} from "../utils";

import { decodeFunctionData } from "viem";
import { GnosisSafeABI } from "../abis/GnosisSafe";
import { replaceBigInts } from "ponder";
import { Agent } from "ponder:schema";

interface ContractCall {
  from: string;
  to: string;
  value: string;
  data: string;
  decodedFunction?: {
    functionName: string;
    args: any;
  };
  implementationAddress?: string;
  tokenTransfers?: TokenTransferData[];
}

interface MultisendTransaction {
  to: string;
  value: string;
  data: string;
  operation: number;
  decodedCalldata?: {
    functionName: string;
    args: any;
  } | null;
  implementationAddress?: string | null;
  contractCalls?: ContractCall[];
  contractAbi?: string | null;
}

const MULTISEND_ABI = [
  {
    type: "function",
    name: "multiSend",
    inputs: [{ type: "bytes", name: "transactions" }],
  },
] as const;

const FPMM_BUY_ABI = [
  {
    type: "function",
    name: "FPMMBuy",
    inputs: [
      { type: "address", name: "buyer" },
      { type: "uint256", name: "investmentAmount" },
      { type: "uint256", name: "feeAmount" },
      { type: "uint256", name: "outcomeIndex" },
      { type: "uint256", name: "outcomeTokensBought" },
    ],
  },
] as const;

const POSITION_SPLIT_ABI = [
  {
    type: "function",
    name: "PositionSplit",
    inputs: [
      { type: "address", name: "stakeholder" },
      { type: "address", name: "collateralToken" },
      { type: "bytes32", name: "parentCollectionId" },
      { type: "bytes32", name: "conditionId" },
      { type: "uint256[]", name: "partition" },
      { type: "uint256", name: "amount" },
    ],
  },
] as const;

const KNOWN_FUNCTION_SIGNATURES = {
  // Existing signatures
  MULTISEND: "0x8d80ff0a", // Gnosis Safe Multisend
  MULTISEND_ALL: "0x86c5899d", // Alternative Multisend implementation
  BATCH: "0xbc197c81", // Another batch transaction format
  FPMM_BUY: "0x4f62630f", // FPMMBuy signature
  POSITION_SPLIT: "0x2e6bb91f", // PositionSplit signature
  // Add more signatures as needed
};

function getTransactionType(data: string): string {
  if (!data || data === "0x") return "SIMPLE_TRANSFER";

  const methodId = data.slice(0, 10).toLowerCase();

  switch (methodId) {
    case KNOWN_FUNCTION_SIGNATURES.MULTISEND:
      return "GNOSIS_MULTISEND";
    case KNOWN_FUNCTION_SIGNATURES.MULTISEND_ALL:
      return "GNOSIS_MULTISEND_ALL";
    case KNOWN_FUNCTION_SIGNATURES.BATCH:
      return "BATCH_TRANSACTION";
    default:
      return "SINGLE_TRANSACTION";
  }
}

interface DecodingError {
  index: number;
  to: string;
  error: string;
  data: string;
}

async function decodeMultisendTransactions(
  data: string,
  chainId: number,
  context: any,
  blockNumber: bigint
): Promise<{
  transactions: MultisendTransaction[];
  errors: DecodingError[];
}> {
  const errors: DecodingError[] = [];
  const transactions: MultisendTransaction[] = [];

  const transactionType = getTransactionType(data);
  console.log(`Processing ${transactionType} transaction`);

  try {
    const txData = data.startsWith("0x") ? data.slice(2) : data;
    let position = 0;

    while (position < txData.length) {
      const operation = parseInt(txData.slice(position, position + 2), 16);
      position += 2;

      const to = "0x" + txData.slice(position, position + 40);
      position += 40;

      const value = BigInt("0x" + txData.slice(position, position + 64));
      position += 64;

      const dataLength =
        parseInt(txData.slice(position, position + 64), 16) * 2;
      position += 64;

      const txnData = "0x" + txData.slice(position, position + dataLength);
      position += dataLength;

      let decodedCalldata = null;
      let contractAbi = null;

      if (txnData && txnData !== "0x") {
        // Try to decode as token transfer first
        const tokenTransfer = decodeTokenTransfer(txnData);

        if (tokenTransfer) {
          decodedCalldata = {
            functionName: `${tokenTransfer.type}_TRANSFER`,
            args: tokenTransfer,
          };
          console.log(`Decoded ${tokenTransfer.type} transfer:`, tokenTransfer);
        }

        // If not a token transfer, try ABI decoding
        if (!decodedCalldata) {
          contractAbi = await checkAndStoreAbi(
            to,
            chainId,
            context,
            blockNumber
          );

          if (contractAbi) {
            try {
              const decoded = decodeFunctionData({
                abi: JSON.parse(contractAbi),
                data: txnData as `0x${string}`,
              });

              decodedCalldata = {
                functionName: decoded.functionName,
                args: processArgs(decoded.args),
              };
            } catch (decodeError) {
              console.log(`Failed ABI decode for ${to}:`, decodeError);
            }
          }
        }
      }

      transactions.push({
        operation,
        to,
        value: value.toString(),
        data: txnData,
        decodedCalldata,
        contractAbi,
      });
    }

    return { transactions, errors };
  } catch (error) {
    console.error("Error decoding multisend transactions:", error);
    return { transactions: [], errors: [] };
  }
}

interface MultisendDetails {
  totalValue: bigint;
  subTransactions: {
    to: string;
    value: string;
    operation: number;
    functionName: string | null;
    args: any | null;
    implementationAddress: string | null;
  }[];
  uniqueRecipients: number;
  failedDecodings: number;
  estimatedGas: bigint;
}

interface MultiCallData {
  to: string;
  value: bigint;
  data: string;
  decodedFunction?: {
    functionName: string;
    args: any;
  };
  contractInteractions?: ContractCall[];
  rawData?: {
    input: string;
    methodId: string;
    params: string;
  };
}

async function decodeMultiCallData(
  input: string,
  chainId: number,
  context: any,
  blockNumber: bigint
): Promise<{ calls: MultiCallData[]; errors: any[] }> {
  let data = input.startsWith("0x") ? input.slice(2) : input;
  let offset = 0;
  const calls: MultiCallData[] = [];
  const errors: any[] = [];

  while (offset < data.length) {
    try {
      const to = "0x" + data.slice(offset, offset + 40);
      offset += 40;

      const valueHex = "0x" + data.slice(offset, offset + 64);
      const value = BigInt(valueHex);
      offset += 64;

      const dataLengthHex = "0x" + data.slice(offset, offset + 64);
      const dataLength = Number(BigInt(dataLengthHex));
      offset += 64;

      const callData = "0x" + data.slice(offset, offset + dataLength * 2);
      offset += dataLength * 2;

      let decodedFunction;
      try {
        const abi = await checkAndStoreAbi(to, chainId, context, blockNumber);
        if (abi) {
          const decoded = decodeFunctionData({
            abi: JSON.parse(abi),
            data: callData as `0x${string}`,
          });
          decodedFunction = {
            functionName: decoded.functionName,
            args: processArgs(decoded.args),
          };
        }
      } catch (error: any) {
        errors.push({ to, error: `Decoding error: ${error.message}` });
      }

      calls.push({
        to,
        value,
        data: callData,
        decodedFunction,
        rawData: {
          input: callData,
          methodId: callData.slice(0, 10),
          params: callData.slice(10),
        },
      });
    } catch (error: any) {
      errors.push({ offset, error: `Parsing error: ${error.message}` });
      // Try to recover and continue with next transaction
      offset += 2;
    }
  }

  return { calls, errors };
}

async function decodeSafeTransaction(
  hash: string,
  input: string,
  chainId: number,
  context: any,
  blockNumber: bigint
): Promise<any | null> {
  try {
    // Try multiSend first
    try {
      const { functionName, args } = decodeFunctionData({
        abi: MULTISEND_ABI,
        data: input as `0x${string}`,
      });

      if (functionName === "multiSend" && args && args[0]) {
        const { calls, errors } = await decodeMultiCallData(
          args[0] as string,
          chainId,
          context,
          blockNumber
        );

        return {
          multiCalls: calls,
          decodingErrors: errors,
          isMulticall: true,
        };
      }
    } catch (error) {
      // Not a multiSend, continue to Safe transaction decoding
    }

    // Try Safe transaction decoding
    const { functionName, args } = decodeFunctionData({
      abi: GnosisSafeABI,
      data: input as `0x${string}`,
    });

    if (functionName === "execTransaction") {
      const transaction = {
        to: args[0],
        value: args[1].toString(),
        data: args[2],
        operation: args[3],
        safeTxGas: args[4].toString(),
        baseGas: args[5].toString(),
        gasPrice: args[6].toString(),
        gasToken: args[7],
        refundReceiver: args[8],
        signatures: args[9],
        decodedFunction: null as { functionName: string; args: any } | null,
      };

      try {
        const { functionName: multiSendFn, args: multiSendArgs } =
          decodeFunctionData({
            abi: MULTISEND_ABI,
            data: transaction.data as `0x${string}`,
          });

        if (multiSendFn === "multiSend" && multiSendArgs && multiSendArgs[0]) {
          const { transactions: multiSendTransactions, errors } =
            await decodeMultisendTransactions(
              multiSendArgs[0] as string,
              chainId,
              context,
              blockNumber
            );

          return {
            ...transaction,
            multiSendTransactions,

            decodingErrors: errors,
            isMultisend: true,
          };
        }
      } catch (error) {
        console.error("Error processing multisend transaction:", error);
      }

      return transaction;
    }

    return null;
  } catch (error) {
    console.error("Error decoding transaction:", error);
    return null;
  }
}

function isTransfer(data: string): boolean {
  return data.startsWith("0xa9059cbb");
}

function decodeTransfer(data: string): { to: string; value: string } | null {
  try {
    if (!isTransfer(data)) return null;

    const transferData = data.slice(10);
    return {
      to: "0x" + transferData.slice(24, 64),
      value: BigInt("0x" + transferData.slice(64)).toString(),
    };
  } catch (error) {
    console.error("Error decoding transfer:", error);
    return null;
  }
}

interface MultisendTransactionSummary {
  totalValue: bigint;
  uniqueRecipients: Set<string>;
  estimatedGas: bigint;
  subTransactionCount: number;
  failedDecodings: number;
}

function summarizeMultisendTransaction(
  transactions: MultisendTransaction[]
): MultisendTransactionSummary {
  return transactions.reduce(
    (summary, tx) => ({
      totalValue: summary.totalValue + BigInt(tx.value),
      uniqueRecipients: summary.uniqueRecipients.add(tx.to),
      subTransactionCount: summary.subTransactionCount + 1,
      failedDecodings: summary.failedDecodings + (tx.decodedCalldata ? 0 : 1),
      estimatedGas: summary.estimatedGas + BigInt(21000), // Basic estimation
    }),
    {
      totalValue: BigInt(0),
      uniqueRecipients: new Set<string>(),
      estimatedGas: BigInt(0),
      subTransactionCount: 0,
      failedDecodings: 0,
    }
  );
}

interface TransactionLogEntry {
  index: number;
  type: "MAIN" | "SUB";
  from: string;
  to: string;
  value: string;
  operation?: number;
  functionName?: string | null;
  args?: any;
  implementationAddress?: string | null;
}

function logUnifiedTransactions(
  hash: string,
  mainTransaction: {
    from: string;
    to: string;
    value: bigint | string;
    decodedFunction?: any;
  },
  safeTransaction?: any
) {
  const transactions: TransactionLogEntry[] = [];

  // Add main transaction
  transactions.push({
    index: 0,
    type: "MAIN",
    from: mainTransaction.from,
    to: mainTransaction.to,
    value: mainTransaction.value.toString(),
    functionName: mainTransaction.decodedFunction
      ? JSON.parse(mainTransaction.decodedFunction).functionName
      : null,
    args: mainTransaction.decodedFunction
      ? JSON.parse(mainTransaction.decodedFunction).args
      : null,
  });

  // Add sub-transactions if it's a multisend
  if (safeTransaction?.multiSendTransactions) {
    safeTransaction.multiSendTransactions.forEach((tx: any, index: number) => {
      transactions.push({
        index: index + 1,
        type: "SUB",
        from: mainTransaction.to, // The main contract is the sender
        to: tx.to,
        value: tx.value.toString(),
        operation: tx.operation,
        functionName: tx.decodedCalldata?.functionName || null,
        args: tx.decodedCalldata?.args || null,
        implementationAddress: tx.implementationAddress || null,
      });
    });
  }

  // Calculate totals
  const totalValue = transactions.reduce(
    (sum, tx) => sum + BigInt(tx.value),
    BigInt(0)
  );
  const uniqueRecipients = new Set(transactions.map((tx) => tx.to)).size;

  // Create formatted log
  console.log(`
Transaction ${hash} Details:
====================================
Total Value: ${totalValue.toString()} wei
Total Transactions: ${transactions.length}
Unique Recipients: ${uniqueRecipients}
Main Transaction Type: ${
    safeTransaction?.multiSendTransactions ? "MULTISEND" : "SINGLE"
  }

Transaction Breakdown:
${transactions
  .map(
    (tx) => `
${
  tx.type === "MAIN"
    ? "📌 MAIN TRANSACTION"
    : `   └─ Sub-transaction #${tx.index}`
}
   From: ${tx.from}
   To: ${tx.to}
   Value: ${tx.value} wei
   ${
     tx.operation !== undefined
       ? `Operation: ${tx.operation === 0 ? "Call" : "DelegateCall"}`
       : ""
   }
   ${tx.functionName ? `Function: ${tx.functionName}` : ""}
   ${tx.args ? `Args: ${JSON.stringify(tx.args, null, 2)}` : ""}
   ${
     tx.implementationAddress
       ? `Implementation: ${tx.implementationAddress}`
       : ""
   }
`
  )
  .join("")}
`);

  return {
    totalValue,
    transactionCount: transactions.length,
    uniqueRecipients,
    transactions,
  };
}

async function processTransaction(
  hash: string,
  event: any,
  context: any,
  isFromTransaction: boolean
) {
  try {
    const fromAddress = event.transaction.from.toString();
    const toAddress = event.transaction.to?.toString();
    const input = event.transaction.input;

    let decodedFunction = null;
    if (input && input !== "0x" && toAddress) {
      try {
        console.log(`Checking ABI for ${toAddress} in processTransaction`);
        const abi = await checkAndStoreAbi(
          toAddress,
          context.network.chainId,
          context,
          BigInt(event.block.number)
        );

        if (abi) {
          const decoded = decodeFunctionData({
            abi: JSON.parse(abi),
            data: input as `0x${string}`,
          });

          const processedArgs = replaceBigInts(decoded.args, (v) => String(v));

          decodedFunction = JSON.stringify({
            functionName: decoded.functionName,
            args: processedArgs,
          });
        }
      } catch (error: any) {
        // Enhanced error logging
        console.error("Function decoding error details:", {
          transactionHash: event.transaction.hash,
          toAddress,
          error: error.message,
          stack: error.stack,
          input: input.slice(0, 100) + "...", // Log first 100 chars of input
        });
      }
    }

    const safeTransaction = await decodeSafeTransaction(
      hash,
      input,
      context.network.chainId,
      context,
      event.block.number
    );

    // Add unified logging
    logUnifiedTransactions(
      hash,
      {
        from: fromAddress,
        to: toAddress || "",
        value: event.transaction.value,
        decodedFunction,
      },
      safeTransaction
    );

    const transactionData = convertBigIntsToStrings({
      hash: event.transaction.hash,
      blockNumber: event.block.number,
      timestamp: event.block.timestamp,
      from: fromAddress,
      to: toAddress || "",
      value: event.transaction.value,
      input: input,
      isMultisend: safeTransaction?.multiSendTransactions?.length > 0,
      decodedData: safeTransaction
        ? JSON.stringify(convertBigIntsToStrings(safeTransaction))
        : null,
      decodedFunction: decodedFunction,
    });

    try {
      await context.db
        .insert(Transaction)
        .values(transactionData)
        .onConflictDoUpdate({
          ...transactionData,
        });
    } catch (error) {
      console.error(`Error inserting transaction: ${error}`);
    }

    if (safeTransaction) {
      const isMultisend = safeTransaction.multiSendTransactions?.length > 0;
      console.log(
        `Processing multisend transaction ${event.transaction.hash}:`,
        {
          isMultisend,
          transactionCount: safeTransaction.multiSendTransactions?.length || 0,
        }
      );

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
            value: tx.value.toString(),
            data: tx.data,
            operationType: tx.operation,
            decodedFunction: tx.decodedCalldata
              ? JSON.stringify(convertBigIntsToStrings(tx.decodedCalldata))
              : null,
            implementationAddress: tx.implementationAddress || null,
            index: i,
          };

          const { id, ...updateFields } = multisendTx;

          try {
            await context.db
              .insert(MultisendTransaction)
              .values(multisendTx)
              .onConflictDoUpdate({
                target: ["id"],
                set: updateFields,
              });
          } catch (error) {
            console.error(
              `Failed to insert multisend transaction ${i}:`,
              error
            );
          }
        }
      }
    }

    if (safeTransaction?.multiSendTransactions) {
      for (const tx of safeTransaction.multiSendTransactions) {
        if (tx.data && isTransfer(tx.data)) {
          const transferData = decodeTransfer(tx.data);
          if (transferData) {
            const transfer = {
              id: `${event.transaction.hash}-${tx.to}-${transferData.to}`,
              hash: event.transaction.hash,
              blockNumber: Number(event.block.number),
              timestamp: Number(event.block.timestamp),
              from: tx.to,
              to: transferData.to,
              value: BigInt(transferData.value),
            };

            await context.db
              .insert(Transfer)
              .values(transfer)
              .onConflictDoUpdate({
                ...transfer,
              });
          }
        }
      }
    }

    // Only check the relevant direction based on the event type
    if (isFromTransaction) {
      await context.db.insert(AgentFromTransaction).values({
        id: `${fromAddress}-${hash}-from`,
        agentId: fromAddress.toLowerCase(),
        transactionHash: hash,
        blockNumber: Number(event.block.number),
        timestamp: Number(event.block.timestamp),
      });
    } else {
      // Check if to address is an agent
      if (toAddress) {
        await context.db.insert(AgentToTransaction).values({
          id: `${toAddress}-${hash}-to`,
          agentId: toAddress.toLowerCase(),
          transactionHash: hash,
          blockNumber: Number(event.block.number),
          timestamp: Number(event.block.timestamp),
        });
      }
    }

    // For multisend transactions, check each sub-transaction
    if (safeTransaction?.multiSendTransactions) {
      for (const tx of safeTransaction.multiSendTransactions) {
        // Check if sub-transaction to address is an agent
        await context.db.insert(AgentToTransaction).values({
          id: `${tx.to}-${hash}-sub-to`,
          agentId: tx.to.toLowerCase(),
          transactionHash: hash,
          blockNumber: Number(event.block.number),
          timestamp: Number(event.block.timestamp),
        });
      }
    }
  } catch (error) {
    console.error("Error processing transaction:", error);
  }
}

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
