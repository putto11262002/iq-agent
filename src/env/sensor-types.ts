import type { Candle, Position, Order, Balance } from "../types/index.ts";

/**
 * Type-safe wrapper around the raw sensor map.
 * Zero-cost abstraction — just casts from the underlying unknown[].
 */
export class TypedSensors {
  constructor(private raw: Map<string, unknown[]>) {}

  candles(sensorId: string): Candle[] {
    return (this.raw.get(sensorId) ?? []) as Candle[];
  }

  mood(sensorId: string): number[] {
    return (this.raw.get(sensorId) ?? []) as number[];
  }

  positions(sensorId: string): Position[] {
    return (this.raw.get(sensorId) ?? []) as Position[];
  }

  orders(sensorId: string): Order[] {
    return (this.raw.get(sensorId) ?? []) as Order[];
  }

  balances(sensorId: string): Balance[] {
    return (this.raw.get(sensorId) ?? []) as Balance[];
  }

  get(sensorId: string): unknown[] {
    return this.raw.get(sensorId) ?? [];
  }

  toMap(): Map<string, unknown[]> {
    return this.raw;
  }
}
