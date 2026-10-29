import {
  AccountBalance,
  Coin,
  CurveCandle,
  CurveLaunch,
  CurveTrade,
  Factory,
  MemcoinFactoryEvent,
  Transfer,
} from "../model";
import { randomUUID } from "node:crypto";
import { IStorage } from "./storage/storage.inteface";
import { BatchService } from "./batch.service";
import { NullAddress } from "../consts";
import { DnsService } from "../dns/dns.service";
import { config } from "../config";

export class EntitiesService {
  constructor(
    private readonly storage: IStorage,
    private readonly batchService: BatchService,
    private readonly dnsService: DnsService
  ) {}

  async init() {
    const factory = await this.storage.getFactory();
    if (config.dnsApiUrl === "off") return;
    try {
      const dnsAddress = await this.dnsService.getAddressByName(
        config.dnsProgramName
      );
      if (dnsAddress && factory.address !== dnsAddress) {
        factory.address = dnsAddress;
        await this.setFactory(factory);
      }
    } catch (e) {
      // An unreachable DNS API must not stop indexing; keep the configured address.
      console.warn(`[entities] DNS lookup failed, keeping ${factory.address}`, e);
    }
  }

  async saveAll() {
    await this.batchService.saveAll();
  }

  getFactory(): Factory {
    return this.storage.getFactory();
  }

  setFactory(factory: Factory) {
    this.storage.setFactory(factory);
    this.batchService.addFactory(factory);
  }

  async getCoin(contract: string) {
    return this.storage.getCoin(contract);
  }

  async getCoinByMemeId(memeId: string) {
    return this.storage.getByMemeId(memeId);
  }

  async removeCoin(coin: Coin) {
    await this.storage.removeCoin(coin);
    this.batchService.removeCoin(coin);
  }

  async getAccountBalance(
    address: string,
    coin: Coin
  ): Promise<AccountBalance> {
    const accountBalance = await this.storage.getAccountBalance(
      address,
      coin.id
    );
    if (accountBalance === undefined) {
      return new AccountBalance({
        id: randomUUID(),
        address,
        coin,
        balance: BigInt(0),
      });
    }
    console.log(
      `[getAccountBalance] ${address} ${coin.id} ${accountBalance.balance}`
    );
    return new AccountBalance({ ...accountBalance, coin });
  }

  async setCoin(coin: Coin) {
    await this.storage.updateCoin(coin);
    this.batchService.addCoinUpdate(coin);
  }

  addTransfer(transfer: Transfer) {
    this.batchService.addTransfer(transfer);
  }

  async setAccountBalance(balance: AccountBalance) {
    if (balance.address !== NullAddress) {
      console.log(
        `[setAccountBalance] ${balance.address} ${balance.coin.id} ${balance.balance}`
      );
      await this.storage.updateAccountBalance(balance);
      this.batchService.addBalanceUpdate(balance);
    }
  }

  async getCurveLaunch(token: string): Promise<CurveLaunch | undefined> {
    return this.storage.getCurveLaunch(token);
  }

  setCurveLaunch(launch: CurveLaunch) {
    this.storage.updateCurveLaunch(launch);
    this.batchService.addCurveLaunch(launch);
  }

  addCurveTrade(trade: CurveTrade) {
    this.batchService.addCurveTrade(trade);
  }

  async getCurveCandle(id: string): Promise<CurveCandle | undefined> {
    return this.storage.getCurveCandle(id);
  }

  setCurveCandle(candle: CurveCandle) {
    this.storage.updateCurveCandle(candle);
    this.batchService.addCurveCandle(candle);
  }

  async addEvent(event: Omit<MemcoinFactoryEvent, "factory" | "id">) {
    const entity = new MemcoinFactoryEvent({
      ...event,
      id: randomUUID(),
      factory: this.storage.getFactory(),
    } as MemcoinFactoryEvent);
    this.batchService.addEvent(entity);
  }
}
