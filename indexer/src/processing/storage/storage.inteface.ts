import { AccountBalance, Coin, CurveCandle, CurveLaunch, Factory } from "../../model";

export interface IStorage {
  getFactory(): Factory;
  setFactory(factory: Factory): void;

  getCoin(address: string): Promise<Coin | undefined>;
  getByMemeId(id: string): Promise<Coin | undefined>;
  updateCoin(coin: Coin): Promise<void>;
  removeCoin(coin: Coin): Promise<void>;

  getAccountBalance(
    address: string,
    contract: string
  ): Promise<AccountBalance | undefined>;
  updateAccountBalance(balance: AccountBalance): Promise<void>;

  getCurveLaunch(token: string): Promise<CurveLaunch | undefined>;
  updateCurveLaunch(launch: CurveLaunch): void;
  getCurveCandle(id: string): Promise<CurveCandle | undefined>;
  updateCurveCandle(candle: CurveCandle): void;
}
