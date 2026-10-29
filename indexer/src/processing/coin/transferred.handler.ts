import { EntitiesService } from "../entities.service";
import { randomUUID } from "node:crypto";
import { ICoinEventHandler } from "./coin.handler";
import { EventInfo } from "../event-info.type";
import { Coin, Transfer } from "../../model";
import { NullAddress } from "../../consts";
import { TransferEvent } from "../../types/coin.events";
import { deductBalance } from "../../types/balance.utils";

export class TransferredHandler implements ICoinEventHandler {
  async handle(
    event: TransferEvent,
    { source: address, timestamp, blockNumber, txHash }: EventInfo,
    storage: EntitiesService
  ): Promise<void> {
    const { from, to, amount } = event;
    const coin = await storage.getCoin(address);

    if (coin === undefined) {
      console.warn(`[TransferredHandler] ${address}: coin is not found`);
      return;
    }

    const fromBalance = await storage.getAccountBalance(from, coin);
    // Curve tokens: the launchpad and the pool hold supply but are not holders.
    const counts = (address: string) => !(coin.excludedHolders ?? []).includes(address);

    storage.addTransfer(
      new Transfer({
        id: randomUUID(),
        coin: coin,
        from,
        to,
        amount,
        blockNumber,
        timestamp,
        extrinsicHash: txHash,
      })
    );

    if (from === NullAddress) {
      console.log(
        `from is NullAddress and amount is added to to account balance ${amount}`
      );

      fromBalance.balance += amount;
      const toBalance = await storage.getAccountBalance(to, coin);

      if (toBalance.balance === BigInt(0) && counts(to)) {
        coin.holders += 1;
      }

      toBalance.balance += amount;

      await storage.setAccountBalance(toBalance);

      coin.circulatingSupply = coin.circulatingSupply + amount;
    } else if (to === NullAddress) {
      deductBalance(fromBalance, amount);

      coin.circulatingSupply = coin.circulatingSupply - amount;
      coin.burned = coin.burned + amount;
    } else {
      fromBalance.balance -= amount;

      const toBalance = await storage.getAccountBalance(to, coin);

      if (toBalance.balance === BigInt(0) && counts(to)) {
        coin.holders += 1;
      }

      toBalance.balance += amount;

      await storage.setAccountBalance(toBalance);

      const isFromAdmin = coin.admins.includes(from);
      const isToAdmin = coin.admins.includes(to);

      if (isFromAdmin && !isToAdmin) {
        coin.distributed += amount;
      } else if (!isFromAdmin && isToAdmin) {
        coin.distributed -= amount;
      }
    }

    if (fromBalance.balance === BigInt(0) && from !== NullAddress && counts(from)) {
      coin.holders -= 1;
    }

    await storage.setAccountBalance(fromBalance);
    await storage.setCoin(new Coin({ ...coin }));
  }
}
