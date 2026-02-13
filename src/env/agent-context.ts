import type { EventBus } from "../events/bus.ts";
import type { TradingEvent } from "../events/types.ts";
import type { Wallet } from "../bot/infra/wallet.ts";
import { apiFetch } from "../cli/api.ts";

export interface AgentContext {
  runId: string;
  /** Current time in seconds. Uses server time in live, simulated time in backtest. */
  now(): number;
  events: {
    emit(type: string, payload: Record<string, unknown>): void;
    on(type: string, handler: (event: TradingEvent) => void): () => void;
  };
  wallet: {
    getBalance(): number;
    getDrawdown(): number;
    getMaxDrawdown(): number;
    getPeak(): number;
  };
  trades: {
    getHistory(runId?: string): Promise<Record<string, unknown>[]>;
  };
  log: {
    debug(message: string, data?: unknown): void;
    signal(direction: "call" | "put", confidence: number, reasons: string[]): void;
  };
}

export function createAgentContext(opts: {
  eventBus: EventBus;
  wallet: Wallet;
  runId: string;
  timeFn?: () => number;
}): AgentContext {
  const { eventBus, wallet, runId } = opts;
  const timeFn = opts.timeFn ?? (() => Math.floor(Date.now() / 1000));

  return {
    runId,
    now: timeFn,

    events: {
      emit(type: string, payload: Record<string, unknown>): void {
        // Agents can only emit agent:* prefixed events
        if (!type.startsWith("agent:")) {
          console.warn(`[AgentContext] Agents can only emit agent:* events, got "${type}"`);
          return;
        }
        eventBus.emit(type as "agent:debug", payload as any);
      },
      on(type: string, handler: (event: TradingEvent) => void): () => void {
        return eventBus.on(type as any, handler);
      },
    },

    wallet: {
      getBalance: () => wallet.getBalance(),
      getDrawdown: () => wallet.getDrawdown(),
      getMaxDrawdown: () => wallet.getMaxDrawdown(),
      getPeak: () => wallet.getPeak(),
    },

    trades: {
      async getHistory(queryRunId?: string): Promise<Record<string, unknown>[]> {
        try {
          const id = queryRunId || runId;
          const res = await apiFetch(`/api/trades?runId=${encodeURIComponent(id)}`, "GET");
          if (!res.ok) return [];
          return await res.json() as Record<string, unknown>[];
        } catch {
          return [];
        }
      },
    },

    log: {
      debug(message: string, data?: unknown): void {
        eventBus.emit("agent:debug", { message, data });
      },
      signal(direction: "call" | "put", confidence: number, reasons: string[]): void {
        eventBus.emit("agent:signal", { direction, confidence, reasons });
      },
    },
  };
}
