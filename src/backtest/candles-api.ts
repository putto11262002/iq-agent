import type { Candle } from "../types/index.ts";
import type { CandlesAPIInterface } from "../env/types.ts";

/**
 * Satisfies CandlesAPIInterface using local dataset candles.
 * Used by agents during backtest to fetch "historical" data.
 */
export class BacktestCandlesAPI implements CandlesAPIInterface {
  private allCandles: Candle[];
  private currentTime: () => number;

  constructor(allCandles: Candle[], currentTime: () => number) {
    this.allCandles = allCandles;
    this.currentTime = currentTime;
  }

  async getCandles(activeId: number, size: number, from: number, to: number): Promise<Candle[]> {
    return this.allCandles.filter(
      (c) => c.active_id === activeId && c.size === size && c.from >= from && c.from <= to,
    );
  }

  async getFirstCandles(activeId: number, size = 1, count = 100): Promise<Candle[]> {
    const now = this.currentTime();
    const matching = this.allCandles.filter(
      (c) => c.active_id === activeId && c.size === size && c.from < now,
    );
    return matching.slice(-count);
  }

  subscribeCandles(_activeId: number, _size: number, _handler: (candle: Candle) => void): void {
    // No-op — candles are fed by the runner via BacktestEnvironment.feedCandle()
  }

  unsubscribeCandles(_activeId: number, _size: number): void {
    // No-op
  }

  resubscribeCandles(_activeId: number, _size: number): void {
    // No-op
  }
}
