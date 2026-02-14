import type { Candle, Position, BlitzOptionConfig } from "../types/index.ts";
import type {
  Action,
  ActionResult,
  Observation,
  EnvironmentRules,
  TradingEnvironmentInterface,
  Agent,
  Sensor,
  TradePayload,
  QueryPayload,
  CandlesAPIInterface,
} from "../env/types.ts";
import { TypedSensors } from "../env/sensor-types.ts";
import type { AgentContext } from "../env/agent-context.ts";
import type { EventBus } from "../events/bus.ts";
import type { Wallet } from "../bot/infra/wallet.ts";
import { EnvironmentState } from "../env/state.ts";
import { SensorManager } from "../env/sensors.ts";
import { BacktestCandlesAPI } from "./candles-api.ts";
import type { PendingTrade } from "./types.ts";

type UpdateCallback = (sensorId: string, data: unknown) => void | Promise<void>;

/** Callback for when a trade is resolved — used by runner to record trades. */
export type TradeResolvedCallback = (trade: PendingTrade, result: "win" | "loss" | "tie", pnl: number, closePrice: number) => void;

export class BacktestEnvironment implements TradingEnvironmentInterface {
  state: EnvironmentState;
  private sensorBuffers: Map<string, unknown[]> = new Map();
  private subscribedSensors: Map<string, Sensor> = new Map();
  private updateCallbacks: Set<UpdateCallback> = new Set();
  private pendingTrades: PendingTrade[] = [];
  private currentTime: number = 0;
  private candlesApi: BacktestCandlesAPI;
  private wallet: Wallet;
  private eventBus: EventBus | null = null;
  private payoutPercent: number;
  private nextPositionId: number = 1;
  private assetConfig: BlitzOptionConfig | null;
  private allCandles: Candle[];
  private maxBufferSize = 100; // [FIX M1] Match live SensorManager default
  private agentRef: Agent | null = null;
  private tradeResolvedCallback: TradeResolvedCallback | null = null;

  private rules: EnvironmentRules = {
    minBet: 1,
    maxBet: 1000000,
    maxConcurrentPositions: 10,
    allowedInstruments: ["blitz-option"],
  };

  constructor(opts: {
    allCandles: Candle[];
    wallet: Wallet;
    eventBus: EventBus | null;
    assetConfig: BlitzOptionConfig | null;
    payoutPercent: number;
  }) {
    this.allCandles = opts.allCandles;
    this.wallet = opts.wallet;
    this.eventBus = opts.eventBus;
    this.assetConfig = opts.assetConfig;
    this.payoutPercent = opts.payoutPercent;

    this.state = new EnvironmentState();
    this.state.balance = opts.wallet.getBalance();
    if (opts.assetConfig) {
      this.state.availableAssets = [opts.assetConfig];
    }

    this.candlesApi = new BacktestCandlesAPI(
      opts.allCandles,
      () => this.currentTime,
    );
  }

  setEventBus(bus: EventBus): void {
    this.eventBus = bus;
  }

  setCurrentTime(ts: number): void {
    this.currentTime = ts;
    this.state.serverTime = ts;
  }

  getCurrentTime(): number {
    return this.currentTime;
  }

  /** Register a callback for when trades are resolved (used by runner for trade recording). */
  onTradeResolved(cb: TradeResolvedCallback): void {
    this.tradeResolvedCallback = cb;
  }

  // ─── TradingEnvironmentInterface ───

  getObservation(): Observation {
    const raw = new Map(this.sensorBuffers);
    return {
      sensors: raw,
      typed: new TypedSensors(raw),
      state: this.state.snapshot(),
      timestamp: this.currentTime,
    };
  }

  async executeActions(actions: Action[]): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i]!;
      try {
        const result = await this.executeAction(action);
        results.push({ actionIndex: i, type: action.type, result });
        if (this.eventBus) {
          this.eventBus.emit("action:executed", { actionType: action.type, payload: action.payload });
        }
      } catch (err) {
        results.push({ actionIndex: i, type: action.type, error: (err as Error).message });
        console.error(`[BacktestEnv] Action ${action.type} failed:`, (err as Error).message);
        if (this.eventBus) {
          this.eventBus.emit("action:failed", { actionType: action.type, payload: action.payload, error: (err as Error).message });
        }
      }
    }
    return results;
  }

  getAvailableAssets(): BlitzOptionConfig[] {
    return this.state.availableAssets;
  }

  getRules(): EnvironmentRules {
    return this.rules;
  }

  getUserId(): number {
    return 0;
  }

  getBalanceId(): number {
    return 0;
  }

  prefillSensor(sensorId: string, data: unknown[]): void {
    // [FIX m-prefill] Match live SensorManager behavior — require buffer to exist
    const buffer = this.sensorBuffers.get(sensorId);
    if (!buffer) return;
    for (const item of data) {
      buffer.push(item);
      if (buffer.length > this.maxBufferSize) buffer.shift();
    }
  }

  getRemainingTime(position: Position): number {
    if (!position.expiration_time) return 0;
    return Math.max(0, position.expiration_time - this.currentTime);
  }

  getCandlesAPI(): CandlesAPIInterface {
    return this.candlesApi;
  }

  // ─── Action execution ───

  private async executeAction(action: Action): Promise<unknown> {
    switch (action.type) {
      case "trade":
        this.executeTrade(action.payload as unknown as TradePayload);
        return undefined;
      case "subscribe":
        this.executeSubscribe(action.payload as unknown as Sensor);
        return undefined;
      case "unsubscribe":
        this.executeUnsubscribe(action.payload.sensorId as string);
        return undefined;
      case "query":
        return this.executeQuery(action.payload as unknown as QueryPayload);
    }
  }

  private executeTrade(payload: TradePayload): void {
    const invest = payload.price;
    if (!this.wallet.canAfford(invest)) {
      throw new Error(`Cannot afford trade: need $${invest}, have $${this.wallet.getBalance()}`);
    }

    // Debit immediately (like real platform holds the money)
    const previousBalance = this.wallet.getBalance();
    this.wallet.debit(invest);
    this.state.balance = this.wallet.getBalance();

    const id = this.nextPositionId++;
    const expirationTime = this.currentTime + payload.expirationSize;

    const trade: PendingTrade = {
      id,
      direction: payload.direction,
      activeId: payload.activeId,
      invest,
      openQuote: payload.currentPrice ?? this.getLatestClose(payload.activeId) ?? 0,
      openTime: this.currentTime,
      expirationTime,
      expirationSize: payload.expirationSize,
      profitPercent: payload.profitPercent ?? this.payoutPercent,
    };

    this.pendingTrades.push(trade);

    // Create open Position and update state
    const openPos = this.tradeToPosition(trade, "open");
    this.state.onPositionChanged(openPos);

    if (this.eventBus) {
      this.eventBus.emit("position:changed", {
        positionId: id,
        status: "open",
        activeId: payload.activeId,
      });
      this.eventBus.emit("trade:placed", {
        activeId: payload.activeId,
        direction: payload.direction,
        amount: invest,
        expirationSize: payload.expirationSize,
      });
      // [FIX M2] Emit wallet:changed on trade open (debit)
      this.eventBus.emit("wallet:changed", {
        balance: this.wallet.getBalance(),
        previousBalance,
        reason: "trade:open",
      });
    }
  }

  private executeSubscribe(sensor: Sensor): void {
    if (this.subscribedSensors.has(sensor.id)) return;
    this.subscribedSensors.set(sensor.id, sensor);

    if (!this.sensorBuffers.has(sensor.id)) {
      this.sensorBuffers.set(sensor.id, []);
    }

    // For candle sensors, pre-fill buffer with candles up to currentTime
    if (sensor.type === "candle") {
      const activeId = sensor.params.active_id as number;
      const size = sensor.params.size as number;
      const buffer = this.sensorBuffers.get(sensor.id)!;
      const historical = this.allCandles.filter(
        (c) => c.active_id === activeId && c.size === size && c.from < this.currentTime,
      );
      // Keep last maxBufferSize candles
      const toFill = historical.slice(-this.maxBufferSize);
      for (const candle of toFill) {
        buffer.push(candle);
      }
    } else {
      // [FIX M-mood] Warn when subscribing to non-candle sensors in backtest
      console.warn(`[BacktestEnv] Sensor type "${sensor.type}" (${sensor.id}) is not simulated — buffer will remain empty`);
    }
  }

  private executeUnsubscribe(sensorId: string): void {
    this.subscribedSensors.delete(sensorId);
    this.sensorBuffers.delete(sensorId);
  }

  private executeQuery(payload: QueryPayload): unknown {
    switch (payload.method) {
      case "getPositions":
        return this.state.openPositions;
      case "getHistory":
        return this.state.snapshot().recentClosedPositions;
      case "getBalances":
        return [{ id: 0, amount: this.state.balance, currency: "USD" }];
      case "getAssets":
        return this.state.availableAssets;
      case "getTradersMood":
        return 0.5; // Placeholder — no mood data in backtest
      case "getCandles":
        return this.candlesApi.getCandles(
          payload.params?.activeId as number,
          payload.params?.size as number,
          payload.params?.from as number,
          payload.params?.to as number,
        );
      default:
        return undefined;
    }
  }

  // ─── Runner-facing methods ───

  /** Push a candle into matching sensor buffers and trigger callbacks. */
  async feedCandle(candle: Candle): Promise<void> {
    const sensorId = SensorManager.candleId(candle.active_id, candle.size);
    const buffer = this.sensorBuffers.get(sensorId);
    if (!buffer) return;

    // Same logic as SensorManager.pushCandle — replace if same `from`, else append
    if (buffer.length > 0) {
      const last = buffer[buffer.length - 1] as Candle;
      if (last.from === candle.from) {
        buffer[buffer.length - 1] = candle;
        for (const cb of this.updateCallbacks) await cb(sensorId, candle);
        return;
      }
    }

    buffer.push(candle);
    if (buffer.length > this.maxBufferSize) buffer.shift();

    for (const cb of this.updateCallbacks) await cb(sensorId, candle);
  }

  /** Check and resolve expired trades against candle data. */
  checkExpirations(): void {
    const toClose: PendingTrade[] = [];
    const remaining: PendingTrade[] = [];

    for (const trade of this.pendingTrades) {
      if (trade.expirationTime <= this.currentTime) {
        toClose.push(trade);
      } else {
        remaining.push(trade);
      }
    }

    this.pendingTrades = remaining;

    for (const trade of toClose) {
      this.resolveTrade(trade);
    }
  }

  /** Force-close all remaining trades at the given price (end of backtest). */
  forceCloseAll(lastPrice: number): void {
    const trades = [...this.pendingTrades];
    this.pendingTrades = [];
    for (const trade of trades) {
      // [FIX M7] Use last candle close for matching asset, fallback to provided price
      const lastAssetCandle = this.findLastCandleForAsset(trade.activeId);
      this.resolveTradeAtPrice(trade, lastAssetCandle ? lastAssetCandle.close : lastPrice);
    }
  }

  /** Get count of pending trades. */
  getPendingTradeCount(): number {
    return this.pendingTrades.length;
  }

  /** Wire agent into the event-driven loop. */
  async runAgent(agent: Agent, ctx?: AgentContext): Promise<void> {
    // [FIX m8] Set agentRef internally so caller doesn't need separate setAgent() call
    this.agentRef = agent;

    await agent.initialize(this, ctx);

    this.updateCallbacks.add(async (_sensorId, _data) => {
      try {
        const obs = this.getObservation();
        const actions = await agent.onObservation(obs);
        if (actions.length > 0) {
          await this.executeActions(actions);
        }
      } catch (err) {
        console.error(`[BacktestEnv] Agent error:`, (err as Error).message);
      }
    });
  }

  /** @deprecated Use runAgent() which sets the agent ref internally. */
  setAgent(agent: Agent): void {
    this.agentRef = agent;
  }

  // ─── Internal helpers ───

  private resolveTrade(trade: PendingTrade): void {
    // [FIX C5] Filter by both activeId AND size to find the correct expiration candle
    const tradeSize = trade.expirationSize; // expiration size may differ from candle size
    // Find candle matching the asset at expiration time — use the dataset's candle size
    const expirationCandle = this.allCandles.find(
      (c) => c.active_id === trade.activeId && c.from >= trade.expirationTime,
    );

    if (!expirationCandle) {
      // [FIX C6] No candle found at expiration — use last known price for this asset
      const lastKnown = this.findLastCandleForAsset(trade.activeId);
      this.resolveTradeAtPrice(trade, lastKnown ? lastKnown.close : trade.openQuote);
      return;
    }

    this.resolveTradeAtPrice(trade, expirationCandle.close);
  }

  private resolveTradeAtPrice(trade: PendingTrade, closePrice: number): void {
    // [FIX C1] Handle tie (close == open) as refund — not a loss
    const isTie = closePrice === trade.openQuote;
    const isWin = !isTie && (
      (trade.direction === "call" && closePrice > trade.openQuote) ||
      (trade.direction === "put" && closePrice < trade.openQuote)
    );

    let pnl: number;
    let closeReason: string;

    if (isTie) {
      // Tie = refund — return the invested amount, PnL is 0
      pnl = 0;
      closeReason = "tie";
      this.wallet.credit(trade.invest); // refund
    } else if (isWin) {
      const profit = trade.invest * (trade.profitPercent / 100);
      pnl = profit;
      closeReason = "win";
      this.wallet.credit(trade.invest + profit);
    } else {
      pnl = -trade.invest;
      closeReason = "loss";
      // Already debited on open — no further action
    }

    this.state.balance = this.wallet.getBalance();

    // Build closed position
    const closedPos = this.tradeToPosition(trade, "closed", {
      closePrice,
      closeReason,
      pnl,
    });
    this.state.onPositionChanged(closedPos);

    // Determine result for events — tie is treated as neither win nor loss
    const eventResult: "win" | "loss" = isWin ? "win" : "loss";

    if (this.eventBus) {
      this.eventBus.emit("position:changed", {
        positionId: trade.id,
        status: "closed",
        activeId: trade.activeId,
      });
      this.eventBus.emit("trade:closed", {
        positionId: trade.id,
        direction: trade.direction,
        result: isTie ? "loss" : eventResult, // events schema only supports win/loss
        pnl,
        invest: trade.invest,
      });
      if (!isTie) {
        // Only emit wallet:changed on actual win/loss (not tie — balance returns to pre-trade)
        const prevBalance = isWin
          ? this.wallet.getBalance() - trade.invest - pnl
          : this.wallet.getBalance();
        this.eventBus.emit("wallet:changed", {
          balance: this.wallet.getBalance(),
          previousBalance: prevBalance,
          reason: isWin ? "trade:win" : "trade:loss",
        });
      }
    }

    // Notify runner for trade recording
    if (this.tradeResolvedCallback) {
      this.tradeResolvedCallback(trade, isTie ? "tie" : (isWin ? "win" : "loss"), pnl, closePrice);
    }

    // Notify agent
    if (this.agentRef) {
      this.agentRef.onTradeResult(closedPos);
    }
  }

  private tradeToPosition(
    trade: PendingTrade,
    status: "open" | "closed",
    closeInfo?: { closePrice: number; closeReason: string; pnl: number },
  ): Position {
    return {
      id: trade.id,
      active_id: trade.activeId,
      direction: trade.direction,
      invest: trade.invest,
      open_quote: trade.openQuote,
      open_time: trade.openTime,
      expiration_time: trade.expirationTime,
      status,
      close_quote: closeInfo?.closePrice ?? 0,
      close_reason: closeInfo?.closeReason ?? "",
      close_time: closeInfo ? this.currentTime : 0,
      pnl: closeInfo?.pnl ?? 0,
      pnl_realized: closeInfo?.pnl ?? 0,
    } as Position;
  }

  private getLatestClose(activeId: number): number | null {
    for (let i = this.allCandles.length - 1; i >= 0; i--) {
      const c = this.allCandles[i]!;
      if (c.active_id === activeId && c.from <= this.currentTime) {
        return c.close;
      }
    }
    return null;
  }

  private findLastCandleForAsset(activeId: number): Candle | null {
    for (let i = this.allCandles.length - 1; i >= 0; i--) {
      if (this.allCandles[i]!.active_id === activeId) {
        return this.allCandles[i]!;
      }
    }
    return null;
  }
}
