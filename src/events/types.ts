export type EventType =
  | "trade:placed" | "trade:closed"
  | "position:changed"
  | "sensor:update"
  | "wallet:changed"
  | "agent:signal" | "agent:debug"
  | "run:started" | "run:stopped"
  | "ws:reconnected"
  | "action:executed" | "action:failed";

export interface TradingEvent {
  id?: number;
  runId: string;
  type: EventType;
  timestamp: number;
  payload: Record<string, unknown>;
}

export interface EventPayloads {
  "trade:placed": { activeId: number; direction: "call" | "put"; amount: number; expirationSize: number };
  "trade:closed": { positionId: number | string; direction?: string; result: "win" | "loss"; pnl: number; invest: number };
  "position:changed": { positionId: number | string; status: "open" | "closed"; activeId: number };
  "sensor:update": { sensorId: string; type: string };
  "wallet:changed": { balance: number; previousBalance: number; reason: string };
  "agent:signal": { direction: "call" | "put"; confidence: number; reasons: string[] };
  "agent:debug": { message: string; data?: unknown };
  "run:started": { agentType: string; agentId: string; config: Record<string, unknown> };
  "run:stopped": { reason: string; totalTrades: number; pnl: number };
  "ws:reconnected": { attempt?: number };
  "action:executed": { actionType: string; payload: unknown };
  "action:failed": { actionType: string; payload: unknown; error: string };
}
