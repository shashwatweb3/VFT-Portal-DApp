import { AccountBalance, Coin, CurveCandle, CurveLaunch, Factory } from "../../model";
import { Store } from "@subsquid/typeorm-store";
import { IStorage } from "./storage.inteface";
import { readFileSync } from "fs";
import { config } from "../../config";
import { add } from "lodash";

let storage: LocalStorage | undefined;

export async function getLocalStorage(store: Store): Promise<LocalStorage> {
  if (storage === undefined) {
    storage = new LocalStorage(store);
    await storage.waitInit();
  }
  storage.setStore(store);
  return storage;
}

const factoryMeta = readFileSync("./assets/factory.meta.txt", "utf8");
const coinMeta = readFileSync("./assets/coin.meta.txt", "utf8");

export class LocalStorage implements IStorage {
  private initialized = false;
  private factory: Factory | undefined;
  // address -> Coin
  private coins: Record<string, Coin> = {};
  // address-coin -> AccountBalance
  private accounts: Record<string, AccountBalance> = {};
  // token -> CurveLaunch, candle id -> CurveCandle (per batch, like `accounts`)
  private launches: Record<string, CurveLaunch> = {};
  private candles: Record<string, CurveCandle> = {};

  constructor(private store: Store) {}

  async waitInit() {
    if (this.initialized) {
      return;
    }
    await this.loadEntities();
    this.initialized = true;
  }

  getFactory(): Factory {
    return this.factory!;
  }

  setFactory(factory: Factory) {
    this.factory = factory;
  }

  setStore(store: Store) {
    this.store = store;
    this.coins = {};
    this.accounts = {};
    this.launches = {};
    this.candles = {};
  }

  async getCoin(address: string): Promise<Coin | undefined> {
    if (this.coins[address] !== undefined) {
      return this.coins[address];
    }
    return this.store.findOne(Coin, { where: { id: address } });
  }

  async getByMemeId(memeId: string): Promise<Coin | undefined> {
    return this.store.findOne(Coin, { where: { memeId } });
  }

  async updateCoin(coin: Coin): Promise<void> {
    this.coins[coin.id] = coin;
  }

  async removeCoin(coin: Coin): Promise<void> {
    delete this.coins[coin.id];
  }

  async getAccountBalance(
    address: string,
    contract: string
  ): Promise<AccountBalance | undefined> {
    const key = `${address}-${contract}`;
    if (this.accounts[key] !== undefined) {
      return this.accounts[key];
    }
    return this.store.findOne(AccountBalance, {
      where: { address, coin: { id: contract } },
    });
  }

  async updateAccountBalance(balance: AccountBalance): Promise<void> {
    const key = `${balance.address}-${balance.coin.id}`;
    this.accounts[key] = balance;
  }

  async getCurveLaunch(token: string): Promise<CurveLaunch | undefined> {
    if (this.launches[token] !== undefined) return this.launches[token];
    const found = await this.store.findOne(CurveLaunch, { where: { id: token }, relations: { coin: true } });
    if (found) this.launches[token] = found;
    return found;
  }

  updateCurveLaunch(launch: CurveLaunch): void {
    this.launches[launch.id] = launch;
  }

  async getCurveCandle(id: string): Promise<CurveCandle | undefined> {
    if (this.candles[id] !== undefined) return this.candles[id];
    const found = await this.store.findOne(CurveCandle, { where: { id } });
    if (found) this.candles[id] = found;
    return found;
  }

  updateCurveCandle(candle: CurveCandle): void {
    this.candles[candle.id] = candle;
  }

  private async loadEntities() {
    await Promise.all([this.loadFactory(), this.loadCoins()]);
  }

  private async loadFactory() {
    this.factory = await this.store.findOne(Factory, { where: {} });

    if (!this.factory) {
      this.factory = new Factory({
        id: config.factoryProgram,
        address: config.factoryProgram,
        meta: factoryMeta,
        coinMeta: coinMeta,
      });
      await this.store.save(this.factory);
    }
  }

  private async loadCoins() {
    const coins = await this.store.find(Coin, { where: {} });
    for (const entity of coins) {
      this.coins[entity.id] = entity;
    }
  }
}
