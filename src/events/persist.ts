import { db } from "../server/db/index.ts";
import { events } from "../server/db/schema.ts";
import type { TradingEvent } from "./types.ts";

/** Creates a persist function that inserts events into the events table.
 *  Skips sensor:update events (too noisy, reconstructable from candle data).
 *  Fire-and-forget — does not block the event loop. */
export function createEventPersister(): (event: TradingEvent) => void {
  return (event: TradingEvent) => {
    // Skip noisy sensor updates
    if (event.type === "sensor:update") return;

    db.insert(events)
      .values({
        runId: event.runId,
        type: event.type,
        timestamp: event.timestamp,
        payload: event.payload,
      })
      .catch((err) => {
        console.warn(`[EventPersist] Failed to persist ${event.type}:`, (err as Error).message);
      });
  };
}
