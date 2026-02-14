import type { Position, BlitzOptionConfig } from "../types/index.ts";
import type { EnvironmentSnapshot } from "./types.ts";

export class EnvironmentState {
  balance: number = 0;
  openPositions: Position[] = [];
  closedCount: number = 0;
  winCount: number = 0;
  lossCount: number = 0;
  totalPnl: number = 0;
  drawdown: number = 0;
  maxDrawdown: number = 0;
  peak: number = 0;
  streak: number = 0;
  private recentClosed: Position[] = [];
  private maxRecentClosed = 50;
  availableAssets: BlitzOptionConfig[] = [];
  serverTime: number = 0;

  /** Update state from a position-changed event */
  onPositionChanged(pos: Position): void {
    if (pos.status === "open") {
      // Add to open positions (avoid duplicates)
      const existing = this.openPositions.findIndex(p => p.id === pos.id);
      if (existing >= 0) {
        this.openPositions[existing] = pos;
      } else {
        this.openPositions.push(pos);
      }
    } else if (pos.status === "closed") {
      // Remove from open positions
      this.openPositions = this.openPositions.filter(p => p.id !== pos.id);
      this.closedCount++;
      this.totalPnl += pos.pnl || 0;

      if (pos.close_reason === "win") {
        this.winCount++;
        this.streak = this.streak > 0 ? this.streak + 1 : 1;
      } else {
        this.lossCount++;
        this.streak = this.streak < 0 ? this.streak - 1 : -1;
      }

      // Drawdown tracking
      if (this.totalPnl > this.peak) this.peak = this.totalPnl;
      this.drawdown = this.peak - this.totalPnl;
      if (this.drawdown > this.maxDrawdown) this.maxDrawdown = this.drawdown;

      // Recent closed ring buffer
      this.recentClosed.push(pos);
      if (this.recentClosed.length > this.maxRecentClosed) this.recentClosed.shift();
    }
  }

  /** Get a snapshot of current state */
  snapshot(): EnvironmentSnapshot {
    return {
      balance: this.balance,
      openPositions: [...this.openPositions],
      closedCount: this.closedCount,
      winCount: this.winCount,
      lossCount: this.lossCount,
      totalPnl: this.totalPnl,
      drawdown: this.drawdown,
      maxDrawdown: this.maxDrawdown,
      peak: this.peak,
      streak: this.streak,
      recentClosedPositions: [...this.recentClosed],
      availableAssets: this.availableAssets,
      serverTime: this.serverTime,
    };
  }
}
