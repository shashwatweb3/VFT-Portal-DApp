import { TypeormDatabase } from "@subsquid/typeorm-store";

import { processor } from "./processor";
import { EventsProcessing } from "./processing/events.processing";
import { EventInfo } from "./processing/event-info.type";
import { Block } from "@subsquid/substrate-processor";
import { EntitiesService } from "./processing/entities.service";
import { getLocalStorage } from "./processing/storage/local.storage";
import { BatchService } from "./processing/batch.service";
import { getMemeFactoryEventsParser } from "./types/factory.events";
import { getCoinEventsParser } from "./types/coin.events";
import { isSailsEvent, isUserMessageSentEvent } from "./utils";
import { getDnsService } from "./dns/dns.service";
import { config } from "./config";
import { getLaunchpadEventsParser } from "./types/launchpad.events";
import { LaunchpadHandler } from "./processing/launchpad/launchpad.handler";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
BigInt.prototype["toJSON"] = function () {
  return this.toString();
};

function getBlockDate(
  block: Block<{ block: { timestamp: boolean }; event: { args: boolean } }>
) {
  return new Date(block.header.timestamp ?? Date.now());
}

processor.run(
  new TypeormDatabase({
    stateSchema: process.env.STATE_SCHEMA ?? "memecoin_processor",
    isolationLevel: "READ COMMITTED",
    supportHotBlocks: true,
  }),
  async (ctx) => {
  const localStorage = await getLocalStorage(ctx.store);
  const dnsService = await getDnsService(config.dnsApiUrl);

  const entitiesService = new EntitiesService(
    localStorage,
    new BatchService(ctx.store),
    dnsService
  );

  await entitiesService.init();

  const memeFactoryParser = await getMemeFactoryEventsParser();
  const coinParser = await getCoinEventsParser();

  const launchpad = config.launchpadProgram;
  const processing = new EventsProcessing(
    entitiesService,
    memeFactoryParser,
    coinParser,
    launchpad ? await getLaunchpadEventsParser() : undefined,
    launchpad ? new LaunchpadHandler(launchpad) : undefined
  );

  const firstBlockDate = getBlockDate(ctx.blocks[0]);

  console.log(
    `[main] start processing ${ctx.blocks.length} blocks at ${firstBlockDate}.`
  );

  for (const block of ctx.blocks) {
    const { events } = block;
    const timestamp = getBlockDate(block);

    for (const event of events) {
      const {
        message: { source, payload, details, destination, id },
      } = event.args;

      if (payload === "0x") continue;
      if (!isUserMessageSentEvent(event) || !isSailsEvent(event)) continue;
      if (details && details.code.__kind !== "Success") continue;

      const eventInfo: EventInfo = {
        blockNumber: block.header.height,
        destination,
        source,
        timestamp,
        messageId: id,
        txHash: id,
      };

      const factory = localStorage.getFactory();

      if (factory.address === source || factory.id === source) {
        await processing.handleFactoryEvent(payload, eventInfo);
      } else if (launchpad && source === launchpad) {
        await processing.handleLaunchpadEvent(payload, eventInfo);
      } else {
        const coin = await localStorage.getCoin(source);

        if (coin) await processing.handleCoinEvent(payload, eventInfo);
      }
    }
  }

  await processing.saveAll();
});
