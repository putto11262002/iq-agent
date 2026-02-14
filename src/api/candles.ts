import type { Protocol } from "../client/protocol.ts";
import type { IQWebSocket } from "../client/ws.ts";
import type { Candle, WsMessage } from "../types/index.ts";
import { CandleSchema, CandlesResponseSchema } from "../schemas/index.ts";

export class CandlesAPI {
  private candleHandlers: Map<string, (candle: Candle) => void> = new Map();

  constructor(
    private protocol: Protocol,
    private ws: IQWebSocket,
  ) {
    // Listen for candle-generated events
    this.ws.on("candle-generated", (msg: WsMessage) => {
      const data = msg.msg as Record<string, unknown>;
      const rawCandles = (data.candles || [data]) as Record<string, unknown>[];
      for (const raw of rawCandles) {
        const parsed = CandleSchema.safeParse(raw);
        if (!parsed.success) {
          console.warn("[CandlesAPI] Candle schema warning:", parsed.error.issues);
          // Fallback: use raw data with manual aliases
          const candle = raw as unknown as Candle;
          const key = `${candle.active_id}_${candle.size}`;
          const handler = this.candleHandlers.get(key);
          if (handler) handler(candle);
          continue;
        }
        const candle = parsed.data;
        const key = `${candle.active_id}_${candle.size}`;
        const handler = this.candleHandlers.get(key);
        if (handler) handler(candle);
      }
    });
  }

  /** Subscribe to real-time candle updates */
  subscribeCandles(
    activeId: number,
    size: number,
    handler: (candle: Candle) => void,
  ): void {
    const key = `${activeId}_${size}`;
    this.candleHandlers.set(key, handler);

    this.protocol.subscribe("candle-generated", undefined, {
      active_id: activeId,
      size,
    });
  }

  /** Unsubscribe from candle updates */
  unsubscribeCandles(activeId: number, size: number): void {
    const key = `${activeId}_${size}`;
    this.candleHandlers.delete(key);

    this.protocol.unsubscribe("candle-generated", undefined, {
      active_id: activeId,
      size,
    });
  }

  /** Get historical candles, validated through CandlesResponseSchema */
  async getCandles(
    activeId: number,
    size: number,
    from: number,
    to: number,
  ): Promise<Candle[]> {
    const res = await this.protocol.sendMessage("get-candles", "2.0", {
      active_id: activeId,
      size,
      from,
      to,
    });
    const parsed = CandlesResponseSchema.safeParse(res.msg);
    if (parsed.success) return parsed.data.candles;

    console.warn("[CandlesAPI] CandlesResponse schema warning:", parsed.error.issues);
    const msg = res.msg as Record<string, unknown>;
    return (msg.candles || []) as Candle[];
  }

  /** Get the latest candles */
  async getFirstCandles(
    activeId: number,
    size = 1,
    count = 100,
  ): Promise<Candle[]> {
    const now = Math.floor(Date.now() / 1000);
    return this.getCandles(activeId, size, now - count * size, now);
  }
}
