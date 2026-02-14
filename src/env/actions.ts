import type { TradingAPI } from "../api/trading.ts";
import type { AccountAPI } from "../api/account.ts";
import type { AssetsAPI } from "../api/assets.ts";
import type { SubscriptionsAPI } from "../api/subscriptions.ts";
import type { SensorManager } from "./sensors.ts";
import type { Action, TradePayload, QueryPayload, Sensor, CandlesAPIInterface } from "./types.ts";

export class ActionExecutor {
  constructor(
    private trading: TradingAPI,
    private account: AccountAPI,
    private assets: AssetsAPI,
    private sensors: SensorManager,
    private subscriptions: SubscriptionsAPI,
    private candlesApi: CandlesAPIInterface,
  ) {}

  async execute(action: Action): Promise<unknown> {
    switch (action.type) {
      case "trade":
        return this.executeTrade(action.payload as unknown as TradePayload);
      case "subscribe":
        return this.sensors.subscribe(action.payload as unknown as Sensor);
      case "unsubscribe":
        return this.sensors.unsubscribe(action.payload.sensorId as string);
      case "query":
        return this.executeQuery(action.payload as unknown as QueryPayload);
      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  }

  private async executeTrade(payload: TradePayload) {
    return this.trading.buyBlitzOption({
      activeId: payload.activeId,
      direction: payload.direction,
      price: payload.price,
      balanceId: payload.balanceId,
      expirationSize: payload.expirationSize,
      profitPercent: payload.profitPercent,
      currentPrice: payload.currentPrice,
    });
  }

  private async executeQuery(payload: QueryPayload) {
    switch (payload.method) {
      case "getPositions":
        return this.trading.getPositions(
          payload.params?.balanceId as number,
          payload.params?.instrumentTypes as string[] | undefined,
        );
      case "getOrders":
        return this.trading.getOrders(
          payload.params?.balanceId as number,
        );
      case "getHistory":
        return this.trading.getHistoryPositions(
          payload.params?.balanceId as number,
        );
      case "getBalances":
        return this.account.getBalances();
      case "getAssets":
        return this.assets.listBlitzOptions();
      case "getTradersMood":
        return this.subscriptions.getTradersMood(
          payload.params?.activeId as number,
          payload.params?.instrument as string | undefined,
        );
      case "getCandles":
        return this.candlesApi.getCandles(
          payload.params?.activeId as number,
          payload.params?.size as number,
          payload.params?.from as number,
          payload.params?.to as number,
        );
      default:
        throw new Error(`Unknown query method: ${payload.method}`);
    }
  }
}
