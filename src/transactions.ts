import { ponder } from "ponder:registry";
import { Transaction, Transfer, MultisendTransaction } from "ponder:schema";
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
}

const MULTISEND_ABI = [
  {
    type: "function",
    name: "multiSend",
    inputs: [{ type: "bytes", name: "transactions" }],
  },
] as const;

const KNOWN_FUNCTION_SIGNATURES = {
  // Existing signatures
  MULTISEND: "0x8d80ff0a", // Gnosis Safe Multisend
  MULTISEND_ALL: "0x86c5899d", // Alternative Multisend implementation
  BATCH: "0xbc197c81", // Another batch transaction format
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

    // Common function signatures
    const SIGNATURES = {
      TRANSFER: "0xa9059cbb",
      TRANSFER_FROM: "0x23b872dd",
      DEPOSIT: "0xd0e30db0",
      WITHDRAW: "0x2e1a7d4d",
      SWAP_EXACT_TOKENS: "0x38ed1739",
      APPROVE: "0x095ea7b3",
      MINT: "0x40c10f19",
      BURN: "0x42966c68",
      EXECUTE: "0xb61d27f6",
      MULTICALL: "0xac9650d8",
      PROXY_FUNCTION: "0x4f1ef286", // Common proxy function signature
      DELEGATE_CALL: "0x5c60da1b", // Delegate call signature
      INITIALIZE: "0x8129fc1c", // Initialize signature
      // ERC721
      TRANSFER_721: "0x42842e0e", // safeTransferFrom(address,address,uint256)
      TRANSFER_721_DATA: "0xb88d4fde", // safeTransferFrom(address,address,uint256,bytes)
      // ERC1155
      TRANSFER_SINGLE: "0xf242432a", // safeTransferFrom(address,address,uint256,uint256,bytes)
      TRANSFER_BATCH: "0x2eb2c2d6", // safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)
    };

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
      if (txnData && txnData !== "0x") {
        try {
          // Log the raw transaction data for debugging
          console.log(`Analyzing transaction to ${to}:`, {
            methodId: txnData.slice(0, 10),
            fullData: txnData,
          });

          // Try to decode as token transfer first
          const tokenTransfer = decodeTokenTransfer(txnData);

          if (tokenTransfer) {
            decodedCalldata = {
              functionName: `${tokenTransfer.type}_TRANSFER`,
              args: tokenTransfer,
            };
            console.log(
              `Decoded ${tokenTransfer.type} transfer:`,
              tokenTransfer
            );
          }

          // If not a token transfer, continue with existing proxy/ABI decoding
          if (!decodedCalldata) {
            // First try to get the implementation address for potential proxy
            const implementationAddress = await getImplementationAddress(
              to,
              chainId,
              context,
              blockNumber
            );

            // If it's a proxy, try to decode using implementation ABI first
            if (implementationAddress?.address) {
              const implAbi = await checkAndStoreAbi(
                implementationAddress.address,
                chainId,
                context,
                blockNumber
              );

              if (implAbi) {
                try {
                  const decoded = decodeFunctionData({
                    abi: JSON.parse(implAbi),
                    data: txnData as `0x${string}`,
                  });

                  decodedCalldata = {
                    functionName: decoded.functionName,
                    args: processArgs(decoded.args),
                  };

                  console.log(`Decoded proxy call to ${to}:`, {
                    implementation: implementationAddress.address,
                    function: decoded.functionName,
                    args: decodedCalldata.args,
                  });
                } catch (proxyError) {
                  console.log(
                    `Failed to decode proxy implementation: ${proxyError}`
                  );
                }
              }
            }

            // If proxy decoding failed or it's not a proxy, try direct ABI
            if (!decodedCalldata) {
              const abi = await checkAndStoreAbi(
                to,
                chainId,
                context,
                blockNumber
              );
              if (abi) {
                try {
                  const decoded = decodeFunctionData({
                    abi: JSON.parse(abi),
                    data: txnData as `0x${string}`,
                  });

                  decodedCalldata = {
                    functionName: decoded.functionName,
                    args: processArgs(decoded.args),
                  };
                } catch (directError) {
                  console.log(`Failed direct ABI decode: ${directError}`);
                }
              }
            }

            // If both attempts failed, try known function signatures
            if (!decodedCalldata && txnData.length >= 10) {
              const methodId = txnData.slice(0, 10).toLowerCase();
              console.log(`Checking method signature: ${methodId}`);

              // Add specific handling for proxy-related functions
              if (methodId === SIGNATURES.PROXY_FUNCTION) {
                decodedCalldata = {
                  functionName: "proxyFunction",
                  args: { raw: txnData },
                };
              } else if (methodId === SIGNATURES.DELEGATE_CALL) {
                decodedCalldata = {
                  functionName: "delegateCall",
                  args: { raw: txnData },
                };
              }
            }
          }
        } catch (error: any) {
          errors.push({
            index: transactions.length,
            to,
            error: error.message,
            data: txnData,
          });
        }
      }

      const implementationAddress = await getImplementationAddress(
        to,
        chainId,
        context,
        blockNumber
      );

      transactions.push({
        operation,
        to,
        value: value.toString(),
        data: txnData,
        decodedCalldata,
        implementationAddress: implementationAddress?.address || null,
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

async function processMultisendDetails(
  transactions: MultisendTransaction[],
  hash: string
): Promise<MultisendDetails> {
  const details: MultisendDetails = {
    totalValue: BigInt(0),
    subTransactions: [],
    uniqueRecipients: 0,
    failedDecodings: 0,
    estimatedGas: BigInt(21000), // Base transaction cost
  };

  const uniqueRecipients = new Set<string>();

  for (const tx of transactions) {
    details.totalValue += BigInt(tx.value);
    uniqueRecipients.add(tx.to.toLowerCase());
    details.estimatedGas += BigInt(21000); // Add basic gas cost per sub-transaction

    details.subTransactions.push({
      to: tx.to,
      value: tx.value,
      operation: tx.operation,
      functionName: tx.decodedCalldata?.functionName || null,
      args: tx.decodedCalldata?.args || null,
      implementationAddress: tx.implementationAddress || null,
    });

    if (!tx.decodedCalldata) {
      details.failedDecodings++;
    }

    // Add extra gas estimation for contract interactions
    if (tx.data && tx.data !== "0x") {
      details.estimatedGas += BigInt(15000); // Additional gas for contract interaction
    }
  }

  details.uniqueRecipients = uniqueRecipients.size;

  // Log detailed breakdown
  console.log(`
Multisend Transaction ${hash.slice(0, 8)}... Details:
====================================
Total Value: ${details.totalValue.toString()} wei
Number of Sub-transactions: ${details.subTransactions.length}
Unique Recipients: ${details.uniqueRecipients}
Failed Decodings: ${details.failedDecodings}
Estimated Gas: ${details.estimatedGas.toString()}

Sub-transactions Breakdown:
${details.subTransactions
  .map(
    (tx, i) => `
  ${i + 1}. To: ${tx.to}
     Value: ${tx.value} wei
     Operation: ${tx.operation === 0 ? "Call" : "DelegateCall"}
     ${
       tx.implementationAddress
         ? `Implementation: ${tx.implementationAddress}`
         : ""
     }
     ${tx.functionName ? `Function: ${tx.functionName}` : "Direct Transfer"}
     ${
       tx.args
         ? `Type: ${(tx.args as TokenTransferData).type || "Unknown"}`
         : ""
     }
     ${tx.args ? `Details: ${JSON.stringify(tx.args, null, 2)}` : ""}
`
  )
  .join("\n")}
  `);

  return details;
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

          const details = await processMultisendDetails(
            multiSendTransactions,
            transaction.data
          );

          return {
            ...transaction,
            multiSendTransactions,
            multiSendDetails: details,
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

const logMultisendDetails = (
  hash: string,
  transactions: MultisendTransaction[],
  summary: MultisendTransactionSummary
) => {
  console.log(`
Multisend Transaction ${hash}:
------------------------
Total Value: ${summary.totalValue}
Sub-transactions: ${summary.subTransactionCount}
Unique Recipients: ${summary.uniqueRecipients.size}
Failed Decodings: ${summary.failedDecodings}
Estimated Gas: ${summary.estimatedGas}

Detailed Breakdown:
${transactions
  .map(
    (tx, i) => `
  ${i + 1}. To: ${tx.to}
     Value: ${tx.value}
     Operation: ${tx.operation}
     Function: ${tx.decodedCalldata?.functionName || "Unknown"}
`
  )
  .join("\n")}
  `);
};

async function processTransaction(event: any, context: any) {
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
          const { functionName, args } = decodeFunctionData({
            abi: JSON.parse(abi),
            data: input as `0x${string}`,
          });
          decodedFunction = JSON.stringify({ functionName, args });
        }
      } catch (error: any) {
        console.log(
          `Could not decode function data for transaction ${event.transaction.hash}: ${error.message}`
        );
      }
    }

    const safeTransaction = await decodeSafeTransaction(
      input,
      context.network.chainId,
      context,
      event.block.number
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
                target: ["id"],
                set: transfer,
              });
          }
        }
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
      await processTransaction(event, context);

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
      const { client } = context;

      console.log(`Handling ${contractName}:transaction:to event`);
      await processTransaction(event, context);

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
