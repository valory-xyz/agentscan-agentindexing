import type { Hex } from "viem";
import { fromHex } from "viem";

import { ponder } from "@/generated";

import { FileStoreFrontendAbi } from "../abis/FileStoreFrontendAbi";

const parseJson = (encodedJson: string, defaultValue: any = null) => {
  try {
    return JSON.parse(encodedJson);
  } catch (e) {
    return defaultValue;
  }
};

ponder.on("Meme:Collected", async ({ event, context }) => {
  console.log("event", event.args);
  await context.db.CollectEvent.create({
    id: event.log.id,
    data: {
      hearter: event.args.hearter,
      memeToken: event.args.memeToken,
      allocation: event.args.allocation,
      timestamp: Number(event.block.timestamp),
      blockNumber: Number(event.block.number),
    },
  });
});

ponder.on("Meme:Hearted", async ({ event, context }) => {
  await context.db.HeartEvent.create({
    id: event.log.id,
    data: {
      hearter: event.args.hearter,
      memeToken: event.args.memeToken,
      amount: event.args.amount,
      timestamp: Number(event.block.timestamp),
      blockNumber: Number(event.block.number),
    },
  });
});

ponder.on("Meme:OLASJourneyToAscendance", async ({ event, context }) => {
  await context.db.OLASJourneyToAscendanceEvent.create({
    id: event.log.id,
    data: {
      olas: event.args.olas,
      amount: event.args.amount,
      timestamp: Number(event.block.timestamp),
      blockNumber: Number(event.block.number),
    },
  });
});

ponder.on("Meme:Purged", async ({ event, context }) => {
  console.log("event", event.args);
  await context.db.PurgeEvent.create({
    id: event.log.id,
    data: {
      memeToken: event.args.memeToken,
      remainingAmount: event.args.remainingAmount,
      timestamp: Number(event.block.timestamp),
      blockNumber: Number(event.block.number),
    },
  });
});

ponder.on("Meme:Summoned", async ({ event, context }) => {
  console.log("event", event.args);
  await context.db.MemeToken.create({
    id: event.args.memeToken,
    data: {
      owner: event.args.summoner,
      lpPairAddress: "",
      liquidity: 0n,
      heartCount: 0n,
      isUnleashed: false,
      timestamp: Number(event.block.timestamp),
      blockNumber: Number(event.block.number),
    },
  });

  await context.db.SummonEvent.create({
    id: event.log.id,
    data: {
      summoner: event.args.summoner,
      memeToken: event.args.memeToken,
      nativeTokenContributed: event.args.nativeTokenContributed,
      timestamp: Number(event.block.timestamp),
      blockNumber: Number(event.block.number),
    },
  });
});

ponder.on("Meme:Unleashed", async ({ event, context }) => {
  console.log("liquidity", event.args);
  await context.db.MemeToken.update({
    id: event.args.memeToken,
    data: {
      lpPairAddress: event.args.lpPairAddress,
      liquidity: event.args.liquidity,
      isUnleashed: true,
    },
  });

  await context.db.UnleashEvent.create({
    id: event.log.id,
    data: {
      unleasher: event.args.unleasher,
      memeToken: event.args.memeToken,
      lpPairAddress: event.args.lpPairAddress,
      liquidity: event.args.liquidity,
      burnPercentageOfStable: event.args.burnPercentageOfStable,
      timestamp: Number(event.block.timestamp),
      blockNumber: Number(event.block.number),
    },
  });
});
