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
  const contractAddress = log.address;
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

    // Handle both string and object ABI formats
    const parsedAbi = Array.isArray(contractAbi)
      ? contractAbi
      : typeof contractAbi === "string"
      ? JSON.parse(contractAbi)
      : contractAbi;

    try {
      // Find matching event fragment
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

    return {
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
  } catch (error: any) {
    console.error(`Failed to decode log for ${contractAddress}:`, error);
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

      if (!log) {
        console.error(`Log ${i} is undefined for transaction ${hash}`);
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
      } else {
        decodedLog = await decodeLogWithDetails(
          log,
          chainId,
          context,
          blockNumber
        );
      }

      if (decodedLog) {
        decodedLogs.push({
          ...log,
          decoded: decodedLog,
        });
      }
    }

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
      } logs`
    );

    console.log(
      `Log Names for ${hash}: ${JSON.parse(transactionData.logs)
        .map((log: any) => {
          const logName = log.decoded?.decoded?.name || "Unknown";
          if (logName === "Unknown") {
            return `Unknown(contract: ${log.decoded?.contractAddress}, signature: ${log.decoded?.eventSignature})`;
          }
          return logName;
        })
        .join(", ")}`
    );

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

    for (const decodedLog of decodedLogs) {
      try {
        await context.db.insert(Log).values({
          id: `${hash}-${decodedLog.logIndex}`,
          chain: context.network?.name,
          transactionHash: hash,
          logIndex: Number(decodedLog.logIndex),
          address: decodedLog?.address?.toString() || "",
          data: decodedLog?.data?.toString() || "",
          topics: JSON.stringify(decodedLog?.topics || []),
          blockNumber: Number(blockNumber),
          timestamp: Number(event.block.timestamp),
          eventName: decodedLog?.decoded?.decoded?.name || null,
          decodedData: decodedLog?.decoded?.decoded?.args
            ? JSON.stringify(
                convertBigIntsToStrings(decodedLog.decoded.decoded.args)
              )
            : null,
        });
      } catch (error) {
        console.error(`Error inserting log for ${hash}:`, error);
      }
    }

    return transactionData;
  } catch (error) {
    console.error("Error processing transaction:", error);
  }
}
