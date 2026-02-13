import type { CandlesAPI } from "../api/candles.ts";
import type { CandlesAPIInterface } from "./types.ts";
import type { TradingAPI } from "../api/trading.ts";
import type { SubscriptionsAPI } from "../api/subscriptions.ts";
import type { Candle, Position, Order } from "../types/index.ts";
import type { Sensor, SensorType } from "./types.ts";

type UpdateCallback = (sensorId: string, data: unknown) => void;

export class SensorManager {
  private activeSensors: Map<string, Sensor> = new Map();
  private sensorData: Map<string, unknown[]> = new Map();
  private updateCallbacks: Set<UpdateCallback> = new Set();
  private maxBufferSize: number;

  constructor(
    private candles: CandlesAPI,
    private trading: TradingAPI,
    private subscriptions: SubscriptionsAPI,
    maxBufferSize = 100,
  ) {
    this.maxBufferSize = maxBufferSize;
  }

  subscribe(sensor: Sensor): void {
    if (this.activeSensors.has(sensor.id)) return; // already subscribed
    this.activeSensors.set(sensor.id, sensor);
    this.sensorData.set(sensor.id, []);

    switch (sensor.type) {
      case "candle": {
        const activeId = sensor.params.active_id as number;
        const size = sensor.params.size as number;
        this.candles.subscribeCandles(activeId, size, (candle: Candle) => {
          this.pushCandle(sensor.id, candle);
        });
        break;
      }
      case "mood": {
        const activeId = sensor.params.active_id as number;
        this.subscriptions.subscribeTradersMood(activeId, (mood: number) => {
          this.pushData(sensor.id, mood);
        });
        break;
      }
      case "position": {
        const userId = sensor.params.user_id as number;
        const balanceId = sensor.params.balance_id as number;
        this.trading.subscribePositions(userId, balanceId, (pos: Position) => {
          this.pushData(sensor.id, pos);
        });
        break;
      }
      case "order": {
        const userId = sensor.params.user_id as number;
        this.trading.subscribeOrders(userId, (order: Order) => {
          this.pushData(sensor.id, order);
        });
        break;
      }
    }
  }

  unsubscribe(sensorId: string): void {
    const sensor = this.activeSensors.get(sensorId);
    if (!sensor) return;

    switch (sensor.type) {
      case "candle": {
        const activeId = sensor.params.active_id as number;
        const size = sensor.params.size as number;
        this.candles.unsubscribeCandles(activeId, size);
        break;
      }
      // mood/position/order don't have explicit unsubscribe in current API
    }

    this.activeSensors.delete(sensorId);
    this.sensorData.delete(sensorId);
  }

  getLatest(sensorId: string): unknown[] {
    return this.sensorData.get(sensorId) || [];
  }

  listActive(): Sensor[] {
    return Array.from(this.activeSensors.values());
  }

  getAllData(): Map<string, unknown[]> {
    return new Map(this.sensorData);
  }

  onUpdate(callback: UpdateCallback): void {
    this.updateCallbacks.add(callback);
  }

  offUpdate(callback: UpdateCallback): void {
    this.updateCallbacks.delete(callback);
  }

  private pushData(sensorId: string, data: unknown): void {
    const buffer = this.sensorData.get(sensorId);
    if (!buffer) return;

    buffer.push(data);
    if (buffer.length > this.maxBufferSize) {
      buffer.shift();
    }

    for (const cb of this.updateCallbacks) {
      cb(sensorId, data);
    }
  }

  /** Push candle data, replacing the last entry if it has the same `from` timestamp (mid-candle update). */
  private pushCandle(sensorId: string, candle: Candle): void {
    const buffer = this.sensorData.get(sensorId);
    if (!buffer) return;

    // If the latest entry has the same `from`, replace it (mid-candle update)
    if (buffer.length > 0) {
      const last = buffer[buffer.length - 1] as Candle;
      if (last.from === candle.from) {
        buffer[buffer.length - 1] = candle;
        for (const cb of this.updateCallbacks) {
          cb(sensorId, candle);
        }
        return;
      }
    }

    // New candle — push normally
    buffer.push(candle);
    if (buffer.length > this.maxBufferSize) {
      buffer.shift();
    }

    for (const cb of this.updateCallbacks) {
      cb(sensorId, candle);
    }
  }

  /** Pre-fill a sensor's buffer with historical data (no callbacks triggered). */
  prefill(sensorId: string, data: unknown[]): void {
    const buffer = this.sensorData.get(sensorId);
    if (!buffer) return;
    for (const item of data) {
      buffer.push(item);
      if (buffer.length > this.maxBufferSize) buffer.shift();
    }
  }

  /** Expose candles API for historical data fetching. */
  getCandlesAPI(): CandlesAPIInterface { return this.candles; }

  /** Re-send server-side subscribe messages for all active sensors (after WS reconnect). */
  resubscribeAll(): void {
    for (const sensor of this.activeSensors.values()) {
      switch (sensor.type) {
        case "candle": {
          const activeId = sensor.params.active_id as number;
          const size = sensor.params.size as number;
          this.candles.resubscribeCandles(activeId, size);
          break;
        }
        case "mood": {
          const activeId = sensor.params.active_id as number;
          this.subscriptions.subscribe("traders-mood-changed", undefined, {
            asset_id: activeId,
            instrument_type: "turbo-option",
          });
          break;
        }
        case "position": {
          const userId = sensor.params.user_id as number;
          const balanceId = sensor.params.balance_id as number;
          this.subscriptions.subscribe("portfolio.position-changed", "3.0", {
            user_id: userId,
            user_balance_id: balanceId,
            instrument_type: "blitz-option",
          });
          break;
        }
        case "order": {
          const userId = sensor.params.user_id as number;
          this.subscriptions.subscribe("portfolio.order-changed", "2.0", {
            user_id: userId,
            instrument_type: "blitz-option",
          });
          break;
        }
      }
    }
    console.log(`[Sensors] Resubscribed ${this.activeSensors.size} sensors`);
  }

  // Helper to build sensor IDs
  static candleId(activeId: number, size: number): string {
    return `candle:${activeId}:${size}`;
  }

  static moodId(activeId: number): string {
    return `mood:${activeId}`;
  }

  static positionId(balanceId: number): string {
    return `position:${balanceId}`;
  }
}
