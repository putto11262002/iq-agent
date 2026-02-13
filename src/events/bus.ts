import type { EventType, EventPayloads, TradingEvent } from "./types.ts";

type Handler = (event: TradingEvent) => void;
type PersistFn = (event: TradingEvent) => void;

export class EventBus {
  private listeners = new Map<EventType | "*", Set<Handler>>();
  private persistFn: PersistFn | null = null;
  private buffer: TradingEvent[] = [];
  private runId: string;
  private timeFn: () => number;

  constructor(runId: string, timeFn?: () => number) {
    this.runId = runId;
    this.timeFn = timeFn ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Type-safe emit — payload is validated against EventPayloads map */
  emit<T extends EventType>(type: T, payload: EventPayloads[T]): void {
    const event: TradingEvent = {
      runId: this.runId,
      type,
      timestamp: this.timeFn(),
      payload: payload as Record<string, unknown>,
    };

    // Notify type-specific listeners
    const handlers = this.listeners.get(type);
    if (handlers) {
      for (const h of handlers) h(event);
    }

    // Notify wildcard listeners
    const wildcards = this.listeners.get("*");
    if (wildcards) {
      for (const h of wildcards) h(event);
    }

    // Persist (or buffer if not yet connected)
    if (this.persistFn) {
      this.persistFn(event);
    } else {
      this.buffer.push(event);
    }
  }

  /** Subscribe to a specific event type or "*" for all. Returns unsubscribe fn. */
  on(type: EventType | "*", handler: Handler): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler);
    return () => { set!.delete(handler); };
  }

  /** Wire persistence after DB is ready. Flushes any buffered events. */
  setPersist(fn: PersistFn): void {
    this.persistFn = fn;
    // Flush buffer
    for (const event of this.buffer) {
      fn(event);
    }
    this.buffer = [];
  }

  getRunId(): string {
    return this.runId;
  }
}
