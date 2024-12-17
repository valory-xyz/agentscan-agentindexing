import { checkAndStoreAbi, convertBigIntsToStrings } from ".";

import {
  AgentFromTransaction,
  AgentToTransaction,
  Log,
  Transaction,
} from "ponder:schema";

import { decodeEventLog } from "viem";

import { Context } from "ponder:registry";
import { SIGNATURES } from "./constants";

async function decodeLogWithDetails(
  log: any,
  chainId: number,
  context: any,
  blockNumber: bigint
) {
  const contractAddress = log.address?.toLowerCase();
  const eventSignature = log.topics[0];

  try {
    const contractAbi = await checkAndStoreAbi(
      contractAddress,
      chainId,
      context,
      blockNumber
    );

    if (!contractAbi) {
      console.log(`No ABI found for contract ${contractAddress}`);
      return {
        contractAddress,
        eventSignature,
        rawData: log.data,
        rawTopics: log.topics,
        decoded: null,
      };
    }

    let decodedEvent = null as any;

    const parsedAbi = Array.isArray(contractAbi)
      ? contractAbi
      : typeof contractAbi === "string"
      ? JSON.parse(contractAbi)
      : contractAbi;

    try {
      const eventFragment = parsedAbi?.find(
        (fragment: any) =>
          fragment.type === "event" && fragment.topics?.[0] === eventSignature
      );

      if (eventFragment) {
        try {
          decodedEvent = decodeEventLog({
            abi: [eventFragment],
            data: log.data,
            topics: log.topics,
          });
        } catch (error) {
          console.log(
            `Failed to decode with event fragment for ${contractAddress}:`,
            error
          );
        }
      }

      // Fallback to full ABI if event fragment decode fails
      if (!decodedEvent) {
        try {
          decodedEvent = decodeEventLog({
            abi: parsedAbi,
            data: log.data,
            topics: log.topics,
          });
        } catch (decodeError) {
          console.error(
            "Full ABI decode failed for contract:",
            contractAddress,
            chainId,
            decodeError
          );
        }
      }
    } catch (error) {
      console.error(`Error in event decoding for ${contractAddress}:`, error);
    }

    if (!decodedEvent) {
      console.log(`[DECODE] Unable to decode event for ${contractAddress}:`, {
        signature: eventSignature,
        hasAbi: !!contractAbi,
        topics: log.topics,
      });
    }

    const result = {
      contractAddress,
      eventSignature,
      decoded: decodedEvent
        ? {
            name: decodedEvent.eventName,
            args: convertBigIntsToStrings(decodedEvent.args),
            signature: eventSignature,
          }
        : null,
      rawData: log.data,
      rawTopics: log.topics,
    };

    return result;
  } catch (error: any) {
    console.error(`[DECODE] Failed to decode log for ${contractAddress}:`, {
      error: error.message,
      signature: eventSignature,
      stack: error.stack,
    });
    return {
      contractAddress,
      eventSignature,
      error: error.message,
      rawData: log.data,
      rawTopics: log.topics,
      decoded: null,
    };
  }
}

export async function processTransaction(
  hash: string,
  event: any,
  context: Context,
  isFromTransaction: boolean
) {
  try {
    const fromAddress = event.transaction?.from?.toString() || "";
    const toAddress = event.transaction?.to?.toString() || "";
    const input = event.transaction?.input || "0x";
    const chainId = context.network?.chainId;
    const blockNumber = event.block?.number;

    if (!hash || !chainId || !blockNumber) {
      console.error("Missing required transaction data:", {
        hash,
        chainId,
        blockNumber,
      });
      return;
    }

    const receipt = await context.client.getTransactionReceipt({
      hash: hash as `0x${string}`,
    });

    const logs = receipt?.logs || [];

    const decodedLogs = [] as any[];

    for (let i = 0; i < logs.length; i++) {
      const log = logs[i];

      const contractAddress = log?.address?.toLowerCase();

      if (!log) {
        console.error(`[TX] Log ${i} is undefined for transaction ${hash}`);
        continue;
      }

      const eventSignature = log?.topics[0];
      let decodedLog = null;

      if (eventSignature === SIGNATURES.ERC20.TRANSFER_EVENT) {
        decodedLog = {
          contractAddress: log.address,
          eventSignature,
          decoded: {
            name: "Transfer",
            args: {
              from: `0x${log.topics[1]?.slice(26)}`,
              to: `0x${log.topics[2]?.slice(26)}`,
              value: convertBigIntsToStrings(log.data),
            },
            signature: eventSignature,
          },
          rawData: log.data,
          rawTopics: log.topics,
        };
      } else if (eventSignature === SIGNATURES.EVENTS.FPMM_BUY) {
        const data = log?.data?.slice(2) || "";
        const investmentAmount = data.slice(0, 64);
        const feeAmount = data.slice(64, 128);
        const outcomeTokensBought = data.slice(128, 192);

        decodedLog = {
          contractAddress: log?.address,
          eventSignature,
          decoded: {
            name: "FPMMBuy",
            args: {
              buyer: `0x${log?.topics[1]?.slice(26) || ""}`,
              outcomeIndex: log?.topics[2] ? parseInt(log?.topics[2], 16) : 0,
              investmentAmount: BigInt("0x" + investmentAmount).toString(),
              feeAmount: BigInt("0x" + feeAmount).toString(),
              outcomeTokensBought: BigInt(
                "0x" + outcomeTokensBought
              ).toString(),
            },
            signature: eventSignature,
          },
          rawData: log?.data,
          rawTopics: log?.topics || [],
        };
        console.log(
          `[TX] Detected FPMM Buy event in log ${i} from contract ${contractAddress} for transaction ${hash}`,
          decodedLog
        );
      } else {
        decodedLog = (await decodeLogWithDetails(
          log,
          chainId,
          context,
          blockNumber
        )) as any;
      }

      if (decodedLog) {
        if (decodedLog.decoded?.name === "FPMMBuy") {
          console.log(
            `[TX] Decoded log for ${hash} in log ${i} from contract ${contractAddress}`,
            decodedLog
          );
        }
        decodedLogs.push({
          ...log,
          decoded: decodedLog,
        });
      } else {
        console.log(
          `[TX] No decoded log found for log ${i} from contract ${contractAddress} with signature ${eventSignature}`
        );
      }
    }
    console.log(`[TX] Finished processing logs for transaction ${hash}`);

    const transactionData = convertBigIntsToStrings({
      hash: event.transaction.hash,
      blockNumber: Number(blockNumber),
      timestamp: Number(event.block.timestamp),
      from: fromAddress,
      to: toAddress || "",
      value: event.transaction.value.toString(),
      input: input,
      isMultisend: decodedLogs.some(
        (log) =>
          log.decoded?.name === "MultiSend" ||
          log.decoded?.name === "MultisigTransaction"
      ),
      logs: JSON.stringify(convertBigIntsToStrings(decodedLogs)),
      chain: context.network?.name,
    });

    console.log(
      `Transaction Data logs length for ${hash}: ${
        JSON.parse(transactionData.logs).length
      } logs!`
    );

    console.log("About to format transaction logs...");

    formatTransactionLogs(hash, JSON.parse(transactionData.logs));

    console.log("Finished formatting transaction logs");

    try {
      await context.db
        .insert(Transaction)
        .values(transactionData)
        .onConflictDoUpdate({
          ...transactionData,
        });
    } catch (error) {
      console.error(`Error inserting Transaction for ${hash}:`, error);
    }

    if (isFromTransaction) {
      try {
        await context.db.insert(AgentFromTransaction).values({
          id: `${fromAddress}-${hash}-from`,
          agentInstanceId: fromAddress.toLowerCase(),
          transactionHash: hash,
          blockNumber: Number(blockNumber),
          timestamp: Number(event.block.timestamp),
          chain: context.network?.name,
        });
      } catch (error) {
        console.error(
          `Error inserting AgentFromTransaction for ${hash}:`,
          error
        );
      }
    } else if (toAddress) {
      try {
        await context.db.insert(AgentToTransaction).values({
          id: `${toAddress}-${hash}-to`,
          agentInstanceId: toAddress.toLowerCase(),
          transactionHash: hash,
          blockNumber: Number(blockNumber),
          timestamp: Number(event.block.timestamp),
          chain: context.network?.name,
        });
      } catch (error) {
        console.error(`Error inserting AgentToTransaction for ${hash}:`, error);
      }
    }

    console.log(
      `[TX] Starting to store ${decodedLogs.length} logs for ${hash}`
    );

    const logValues = decodedLogs.map((decodedLog) => {
      const eventName =
        decodedLog?.decoded?.decoded?.name ||
        decodedLog?.decoded?.name ||
        "Unknown";
      const contractAddress = decodedLog.address?.toLowerCase();

      return {
        id: `${hash}-${decodedLog.logIndex}`,
        chain: context.network?.name,
        transactionHash: hash,
        logIndex: Number(decodedLog.logIndex),
        address: contractAddress || "",
        data: decodedLog?.data?.toString() || "",
        topics: JSON.stringify(decodedLog?.topics || []),
        blockNumber: Number(blockNumber),
        timestamp: Number(event.block.timestamp),
        eventName: eventName || null,
        decodedData: decodedLog?.decoded?.decoded?.args
          ? JSON.stringify(
              convertBigIntsToStrings(decodedLog.decoded.decoded.args)
            )
          : null,
      };
    });

    if (logValues.length > 0) {
      try {
        console.log(
          `[TX] Batch inserting ${logValues.length} logs for transaction ${hash}`
        );
        await context.db.insert(Log).values(logValues);
        console.log(
          `[TX] Successfully inserted ${logValues.length} logs for ${hash}`
        );
      } catch (error) {
        console.error(`[TX] Error batch inserting logs for ${hash}:`, {
          error: error instanceof Error ? error.message : "Unknown error",
          logCount: logValues.length,
        });

        console.log(`[TX] Attempting individual inserts for ${hash}`);
        for (const logValue of logValues) {
          try {
            await context.db.insert(Log).values(logValue);
          } catch (individualError) {
            console.error(`[TX] Error inserting individual log for ${hash}:`, {
              logIndex: logValue.logIndex,
              contractAddress: logValue.address,
              error:
                individualError instanceof Error
                  ? individualError.message
                  : "Unknown error",
            });
          }
        }
      }
    }

    return transactionData;
  } catch (error) {
    console.error("[TX] Error processing transaction:", {
      hash,
      error:
        error instanceof Error
          ? {
              message: error.message,
              stack: error.stack,
            }
          : "Unknown error",
    });
  }
}

export const formatTransactionLogs = (hash: string, logs: any[]) => {
  console.log("\n=== Transaction Logs Format ===");
  console.log(`Transaction Hash: ${hash}`);
  console.log(`Total Logs: ${logs.length}`);

  logs.forEach((log, index) => {
    console.log(`\nLog #${index + 1}:`);
    console.log("Contract Address:", log.decoded.contractAddress);
    console.log("Event Name:", log.decoded.decoded?.name || "Unknown");

    if (log.decoded.decoded?.args) {
      console.log(
        "Arguments:",
        JSON.stringify(log.decoded.decoded.args, null, 2)
      );
    }

    console.log("Event Signature:", log.decoded.eventSignature);
  });

  console.log("\n=== End Transaction Logs ===\n");
};
