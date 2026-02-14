import type { Protocol } from "../client/protocol.ts";
import type { IQWebSocket } from "../client/ws.ts";
import type { AccountAPI } from "../api/account.ts";
import type { AssetsAPI } from "../api/assets.ts";
import type { CandlesAPI } from "../api/candles.ts";
import type { CandlesAPIInterface } from "./types.ts";
import type { TradingAPI } from "../api/trading.ts";
import type { SubscriptionsAPI } from "../api/subscriptions.ts";
import type { Position, BlitzOptionConfig, BalanceChanged } from "../types/index.ts";
import { authenticateWs } from "../client/auth.ts";
import type {
  Action,
  ActionResult,
  Observation,
  EnvironmentRules,
  TradingEnvironmentInterface,
  Agent,
} from "./types.ts";
import { TypedSensors } from "./sensor-types.ts";
import type { AgentContext } from "./agent-context.ts";
import type { EventBus } from "../events/bus.ts";
import { SensorManager } from "./sensors.ts";
import { ActionExecutor } from "./actions.ts";
import { EnvironmentState } from "./state.ts";

export class TradingEnvironment implements TradingEnvironmentInterface {
  sensors: SensorManager;
  actions: ActionExecutor;
  state: EnvironmentState;
  rules: EnvironmentRules;

  private protocol: Protocol;
  private ws: IQWebSocket;
  private account: AccountAPI;
  private assets: AssetsAPI;
  private trading: TradingAPI;
  private subscriptions: SubscriptionsAPI;

  private userId: number = 0;
  private balanceId: number = 0;
  private ssid: string = "";
  private eventBus: EventBus | null = null;

  constructor(
    protocol: Protocol,
    ws: IQWebSocket,
    account: AccountAPI,
    assets: AssetsAPI,
    candles: CandlesAPI,
    trading: TradingAPI,
    subscriptions: SubscriptionsAPI,
  ) {
    this.protocol = protocol;
    this.ws = ws;
    this.account = account;
    this.assets = assets;
    this.trading = trading;
    this.subscriptions = subscriptions;

    this.sensors = new SensorManager(candles, trading, subscriptions, account);
    this.state = new EnvironmentState();
    this.actions = new ActionExecutor(trading, account, assets, this.sensors, subscriptions, candles);

    this.rules = {
      minBet: 1,
      maxBet: 1000000,
      maxConcurrentPositions: 10,
      allowedInstruments: ["blitz-option"],
    };
  }

  async initialize(accountMode: "demo" | "real" = "demo"): Promise<void> {
    // Fetch profile
    const profile = await this.account.getProfile();
    this.userId = profile.user_id;

    // Fetch balance by mode (demo or real)
    const balance = await this.account.getBalanceByMode(accountMode);
    this.balanceId = balance.id;
    this.state.balance = balance.amount;

    // Activate this balance on IQ's side
    await this.account.changeBalance(this.balanceId);

    // Enable trade results
    this.account.setOptions({ sendResults: true });

    // Fetch available assets
    const initData = await this.assets.getInitializationData();
    const allConfigs = this.assets.parseBlitzOptions(initData);
    this.state.availableAssets = allConfigs.filter(c => c.is_enabled && !c.is_suspended);

    // Update rules from first available asset
    if (this.state.availableAssets.length > 0) {
      const minBets = this.state.availableAssets.map(a => a.minimal_bet);
      this.rules.minBet = Math.min(...minBets);
    }

    // Subscribe to position changes and option-closed on the server
    this.trading.subscribePositions(this.userId, this.balanceId, (pos: Position) => {
      this.state.onPositionChanged(pos);
      if (this.eventBus) {
        this.eventBus.emit("position:changed", {
          positionId: pos.id,
          status: pos.status as "open" | "closed",
          activeId: pos.active_id,
        });
      }
    });
    this.protocol.subscribe("option-closed", undefined, {});

    // Subscribe to balance-changed for real-time balance updates
    this.account.subscribeBalanceChanged((data: BalanceChanged) => {
      if (data.current_balance.id === this.balanceId) {
        const previousBalance = this.state.balance;
        this.state.balance = data.current_balance.amount;
        if (this.eventBus) {
          this.eventBus.emit("wallet:changed", {
            balance: data.current_balance.amount,
            previousBalance,
            reason: "balance-changed",
          });
        }
      }
    });

    console.log(`[Environment] Initialized: user=${this.userId}, balance=$${this.state.balance}, assets=${this.state.availableAssets.length}`);

    // Setup reconnect handler — re-auth and re-subscribe everything
    this.ws.onReconnect(async () => {
      console.log("[Environment] Reconnected — re-authenticating...");
      try {
        await authenticateWs(this.protocol, this.ssid);
        this.account.setOptions({ sendResults: true });
        this.sensors.resubscribeAll();
        // Re-subscribe balance-changed
        this.protocol.subscribe("balance-changed", "1.0", {});
        // Re-subscribe position-changed (TradingAPI handlers are still registered)
        this.protocol.subscribe("portfolio.position-changed", "3.0", {
          user_id: this.userId,
          user_balance_id: this.balanceId,
          instrument_type: "blitz-option",
        });
        this.protocol.subscribe("option-closed", undefined, {});
        console.log("[Environment] Reconnect complete — all subscriptions restored");
        if (this.eventBus) {
          this.eventBus.emit("ws:reconnected", {});
        }
      } catch (err) {
        console.error("[Environment] Reconnect re-auth failed:", (err as Error).message);
      }
    });
  }

  /** Wire an EventBus for emitting environment events. */
  setEventBus(bus: EventBus): void { this.eventBus = bus; }

  /** Store the ssid for reconnect re-authentication. */
  setSsid(ssid: string): void { this.ssid = ssid; }

  getUserId(): number { return this.userId; }
  getBalanceId(): number { return this.balanceId; }

  prefillSensor(sensorId: string, data: unknown[]): void {
    this.sensors.prefill(sensorId, data);
  }

  getCandlesAPI(): CandlesAPIInterface {
    return this.sensors.getCandlesAPI();
  }

  /** Get remaining seconds until a position expires. Returns 0 if already expired or no expiration set. */
  getRemainingTime(position: Position): number {
    if (!position.expiration_time) return 0;
    const serverNow = this.ws.serverTime
      ? Math.floor(this.ws.serverTime / 1000)
      : Math.floor(Date.now() / 1000);
    return Math.max(0, position.expiration_time - serverNow);
  }

  getObservation(): Observation {
    this.state.serverTime = this.ws.serverTime
      ? Math.floor(this.ws.serverTime / 1000)
      : Math.floor(Date.now() / 1000);

    const raw = this.sensors.getAllData();
    return {
      sensors: raw,
      typed: new TypedSensors(raw),
      state: this.state.snapshot(),
      timestamp: this.state.serverTime,
    };
  }

  async executeActions(actions: Action[]): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i]!;
      try {
        const result = await this.actions.execute(action);
        results.push({ actionIndex: i, type: action.type, result });
        if (this.eventBus) {
          this.eventBus.emit("action:executed", { actionType: action.type, payload: action.payload });
        }
      } catch (err) {
        results.push({ actionIndex: i, type: action.type, error: (err as Error).message });
        console.error(`[Environment] Action ${action.type} failed:`, (err as Error).message);
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

  /** Run an agent in the event-driven loop */
  async runAgent(agent: Agent, ctx?: AgentContext): Promise<void> {
    console.log(`[Environment] Starting agent: ${agent.name}`);
    await agent.initialize(this, ctx);

    // On every sensor update, get observation and let agent decide
    this.sensors.onUpdate(async (_sensorId, _data) => {
      try {
        const obs = this.getObservation();
        const actions = await agent.onObservation(obs);
        if (actions.length > 0) {
          await this.executeActions(actions);
        }
      } catch (err) {
        console.error(`[Environment] Agent error:`, (err as Error).message);
      }
    });

    // Wire onTradeResult — notify agent when positions close
    this.trading.onPositionChanged((pos: Position) => {
      if (pos.status === "closed") {
        agent.onTradeResult(pos);
      }
    });

    console.log(`[Environment] Agent ${agent.name} running. Waiting for sensor data...`);
  }

  /** Get the trading API for direct position subscriptions (used by Runner). */
  getTradingAPI(): TradingAPI {
    return this.trading;
  }
}
