import { EntitiesService } from "../entities.service";
import { EventInfo } from "../event-info.type";
import { MemeCreatedEvent } from "../../types/factory.events";
import { IFactoryEventHandler } from "./factory.handler";
import { Coin, CoinKind } from "../../model";

export class MemeCreatedHandler implements IFactoryEventHandler {
  async handle(
    event: MemeCreatedEvent,
    eventInfo: EventInfo,
    storage: EntitiesService
  ): Promise<void> {
    const {
      address,
      memeId,
      config: {
        name,
        symbol,
        decimals,
        description,
        initialCapacity,
        initialSupply,
        maxSupply,
        admin,
        image,
        twitter,
        telegram,
        discord,
        website,
        tokenomics,
      },
    } = event;
    const existed = await storage.getCoin(address);
    if (existed !== undefined) {
      console.warn(`[MemeCreatedHandler] ${address}: coin already exists`);
      return;
    }
    const coin = new Coin({
      id: address,
      memeId,
      name,
      symbol,
      decimals,
      description,
      initialSupply,
      image,
      twitter,
      telegram,
      discord,
      website,
      tokenomics,
      circulatingSupply: initialSupply,
      burned: 0n,
      holders: 1,
      distributed: 0n,
      admins: [admin],
      screenshots: [],
      maxSupply,
      createdBy: admin || eventInfo.destination,
      timestamp: eventInfo.timestamp,
      kind: CoinKind.CLASSIC,
      excludedHolders: [],
    });
    await storage.setCoin(coin);
    const balance = await storage.getAccountBalance(admin, coin);
    balance.balance = initialSupply;
    await storage.setAccountBalance(balance);
  }
}
