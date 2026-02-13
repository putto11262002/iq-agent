import type { Position, BlitzOptionConfig, Candle } from "../types/index.ts";
import type { AgentContext } from "./agent-context.ts";

// Interface for candles data access — implemented by both live CandlesAPI and BacktestCandlesAPI
export interface CandlesAPIInterface {
  getCandles(activeId: number, size: number, from: number, to: number): Promise<Candle[]>;
  getFirstCandles(activeId: number, size?: number, count?: number): Promise<Candle[]>;
  subscribeCandles(activeId: number, size: number, handler: (candle: Candle) => void): void;
  unsubscribeCandles(activeId: number, size: number): void;
  resubscribeCandles(activeId: number, size: number): void;
}

// Sensor descriptor — a named data stream the agent can subscribe/unsubscribe
export interface Sensor {
  id: string;                    // e.g. "candle:76:1", "mood:76", "position:*"
  type: SensorType;
  params: Record<string, unknown>;
}

export type SensorType = "candle" | "mood" | "position" | "order" | "balance";

// Actions the agent can take
export interface Action {
  type: ActionType;
  payload: Record<string, unknown>;
}

export type ActionType = "trade" | "subscribe" | "unsubscribe" | "query";

// Trade action payload
export interface TradePayload {
  activeId: number;
  direction: "call" | "put";
  price: number;
  balanceId: number;
  expirationSize: number;
  profitPercent?: number;
  currentPrice?: number;
}

// Query action payload
export interface QueryPayload {
  method: "getPositions" | "getOrders" | "getHistory" | "getBalances" | "getAssets";
  params?: Record<string, unknown>;
}

// What the agent observes
export interface Observation {
  sensors: Map<string, unknown[]>;  // sensor_id → latest N values
  state: EnvironmentSnapshot;
  timestamp: number;
}

// Snapshot of environment state
export interface EnvironmentSnapshot {
  balance: number;
  openPositions: Position[];
  closedCount: number;
  winCount: number;
  lossCount: number;
  totalPnl: number;
  availableAssets: BlitzOptionConfig[];
  serverTime: number;
}

// Rules / constraints for the environment
export interface EnvironmentRules {
  minBet: number;
  maxBet: number;
  maxConcurrentPositions: number;
  allowedInstruments: string[];
}

// The agent interface — can be algorithm, RL, or LLM
export interface Agent {
  name: string;
  initialize(env: TradingEnvironmentInterface, ctx?: AgentContext): Promise<void>;
  onObservation(obs: Observation): Promise<Action[]>;
  onTradeResult(position: Position): void;
}

// Interface for TradingEnvironment (to avoid circular deps)
export interface TradingEnvironmentInterface {
  getObservation(): Observation;
  executeActions(actions: Action[]): Promise<void>;
  getAvailableAssets(): BlitzOptionConfig[];
  getRules(): EnvironmentRules;
  getUserId(): number;
  getBalanceId(): number;
  prefillSensor(sensorId: string, data: unknown[]): void;
  getCandlesAPI(): CandlesAPIInterface;
}
