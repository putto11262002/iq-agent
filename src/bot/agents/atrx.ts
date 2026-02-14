import type { Candle, Position } from "../../types/index.ts";
import type {
  Agent,
  Action,
  Observation,
  TradingEnvironmentInterface,
} from "../../env/types.ts";
import type { AgentContext } from "../../env/agent-context.ts";

import { SensorManager } from "../../env/sensors.ts";

export interface ATRXAgentConfig {
  activeId: number;
  agentId?: string;

  // Timeframes (seconds)
  trendCandleSize: number; // e.g. 300 (5m)
  entryCandleSize: number; // e.g. 60  (1m)

  // Execution
  tradeAmount: number;
  baseExpirationSize: number; // e.g. 60
  fastExpirationSize: number; // e.g. 30
  allowFastExpiry: boolean;
  maxOpenTrades: number;
  warmupCandles: number;

  // Market gates
  minPayoutPercent: number;
  deadtimeSeconds: number;

  // Trend/regime (trend timeframe)
  emaTrendPeriod: number;
  emaTrendSlopeLookback: number;
  minTrendSlopePct: number; // abs(emaSlope) / price * 100

  atrPeriod: number;
  atrWindow: number;
  atrPctMin: number; // ATR/price * 100
  atrPctMax: number; // ATR/price * 100
  atrPercentileMin: number;
  atrPercentileMax: number;

  // Entry mechanics (entry timeframe)
  emaEntryPeriod: number;
  swingLookback: number;
  breakoutBufferPct: number;
  setupTtlCandles: number;

  retestProximityAtr: number;
  retestMinBodyPct: number;
  levelEmaProximityAtr: number;
  maxExtensionAtr: number;
  impulseAtrK: number;

  // Fast expiry qualification
  fastMinTrendSlopePct: number;
  fastMaxAtrPct: number;

  // Risk
  cooldownAfterTrade: number;
  maxConsecutiveLosses: number;
  lossPauseDuration: number;
  maxTotalLoss: number; // stop trading when totalPnl <= -maxTotalLoss

  debug: boolean;
}

export const DEFAULT_ATRX_CONFIG: Omit<ATRXAgentConfig, "activeId"> = {
  agentId: "dyn",

  trendCandleSize: 300,
  entryCandleSize: 60,

  tradeAmount: 20,
  baseExpirationSize: 60,
  fastExpirationSize: 30,
  allowFastExpiry: true,
  maxOpenTrades: 1,
  // Sensor buffers keep the last ~100 candles; keep warmup <= that.
  warmupCandles: 100,

  minPayoutPercent: 80,
  deadtimeSeconds: 8,

  emaTrendPeriod: 50,
  emaTrendSlopeLookback: 3,
  minTrendSlopePct: 0.002,

  atrPeriod: 14,
  atrWindow: 100,
  atrPctMin: 0.005,
  atrPctMax: 0.25,
  atrPercentileMin: 20,
  atrPercentileMax: 85,

  emaEntryPeriod: 20,
  swingLookback: 12,
  breakoutBufferPct: 0.01,
  setupTtlCandles: 6,

  retestProximityAtr: 0.35,
  retestMinBodyPct: 45,
  levelEmaProximityAtr: 0.9,
  maxExtensionAtr: 1.4,
  impulseAtrK: 0.45,

  fastMinTrendSlopePct: 0.004,
  fastMaxAtrPct: 0.06,

  cooldownAfterTrade: 30,
  maxConsecutiveLosses: 3,
  lossPauseDuration: 180,
  maxTotalLoss: 200,

  debug: false,
};

type Direction = "call" | "put";

type PendingSetup = {
  direction: Direction;
  level: number;
  createdAt: number;
  expiresAt: number;
  origin: "breakout";
};

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const p = Math.max(1, Math.floor(period));
  const k = 2 / (p + 1);
  const out: number[] = [values[0]!];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i]! * k + out[i - 1]! * (1 - k));
  }
  return out;
}

function trueRange(curr: Candle, prevClose: number | undefined): number {
  const high = curr.max;
  const low = curr.min;
  if (prevClose === undefined) return high - low;
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

// Wilder/RMA smoothing, common for ATR
function atr(candles: Candle[], period: number): number[] {
  const p = Math.max(1, Math.floor(period));
  if (candles.length === 0) return [];
  const tr: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const prevClose = i > 0 ? candles[i - 1]!.close : undefined;
    tr.push(trueRange(candles[i]!, prevClose));
  }
  const out: number[] = [];
  let prev = tr[0]!;
  out.push(prev);
  for (let i = 1; i < tr.length; i++) {
    prev = (prev * (p - 1) + tr[i]!) / p;
    out.push(prev);
  }
  return out;
}

function highestHigh(candles: Candle[], lookback: number): number {
  const lb = Math.max(1, Math.floor(lookback));
  const start = Math.max(0, candles.length - lb);
  let hi = -Infinity;
  for (let i = start; i < candles.length; i++) {
    hi = Math.max(hi, candles[i]!.max);
  }
  return hi;
}

function lowestLow(candles: Candle[], lookback: number): number {
  const lb = Math.max(1, Math.floor(lookback));
  const start = Math.max(0, candles.length - lb);
  let lo = Infinity;
  for (let i = start; i < candles.length; i++) {
    lo = Math.min(lo, candles[i]!.min);
  }
  return lo;
}

function candleBodyPct(c: Candle): number {
  const range = Math.max(1e-12, c.max - c.min);
  const body = Math.abs(c.close - c.open);
  return (body / range) * 100;
}

function percentileRank(values: number[], value: number): number {
  if (values.length === 0) return 0;
  let below = 0;
  for (const v of values) {
    if (v < value) below++;
  }
  return (below / values.length) * 100;
}

function safeNow(obs: Observation): number {
  return obs.timestamp || Math.floor(Date.now() / 1000); // lint:allow-date-now — fallback only
}

function remainingInWindow(now: number, windowSec: number): number {
  const w = Math.max(1, Math.floor(windowSec));
  return w - (now % w);
}

export class ATRXAgent implements Agent {
  name = "ATRX";

  private cfg: ATRXAgentConfig;
  private ctx: AgentContext | undefined;

  private balanceId = 0;
  private profitPercent = 80;

  private lastEntryFrom = 0;
  private pending: PendingSetup | null = null;
  private cooldownUntil = 0;
  private consecutiveLosses = 0;
  private pauseUntil = 0;
  private stopTrading = false;

  constructor(config: ATRXAgentConfig) {
    this.cfg = config;
    const suffix = config.agentId || "dyn";
    this.name = `ATRX-${suffix}`;
  }

  private dbg(msg: string, data?: unknown): void {
    if (!this.cfg.debug) return;
    console.log(`[${this.name}:DBG] ${msg}`);
    if (this.ctx) this.ctx.log.debug(msg, data);
  }

  async initialize(env: TradingEnvironmentInterface, ctx?: AgentContext): Promise<void> {
    this.ctx = ctx;
    this.balanceId = env.getBalanceId();

    const obs = env.getObservation();
    const asset = obs.state.availableAssets.find(a => a.active_id === this.cfg.activeId);
    if (asset && asset.profit_commission > 0) {
      this.profitPercent = 100 - asset.profit_commission;
    }

    const trendId = SensorManager.candleId(this.cfg.activeId, this.cfg.trendCandleSize);
    const entryId = SensorManager.candleId(this.cfg.activeId, this.cfg.entryCandleSize);

    await env.executeActions([
      {
        type: "subscribe",
        payload: {
          id: trendId,
          type: "candle",
          params: { active_id: this.cfg.activeId, size: this.cfg.trendCandleSize },
        },
      },
      {
        type: "subscribe",
        payload: {
          id: entryId,
          type: "candle",
          params: { active_id: this.cfg.activeId, size: this.cfg.entryCandleSize },
        },
      },
    ]);

    // Prefill to enable gates immediately.
    try {
      const candlesApi = env.getCandlesAPI();
      const count = Math.max(this.cfg.warmupCandles, this.cfg.atrWindow + this.cfg.atrPeriod + 20);
      const trendHist = await candlesApi.getFirstCandles(this.cfg.activeId, this.cfg.trendCandleSize, count);
      const entryHist = await candlesApi.getFirstCandles(this.cfg.activeId, this.cfg.entryCandleSize, count);
      if (trendHist.length > 0) env.prefillSensor(trendId, trendHist);
      if (entryHist.length > 0) env.prefillSensor(entryId, entryHist);
      this.dbg("Prefilled candles", { trend: trendHist.length, entry: entryHist.length });
    } catch (err) {
      console.warn(`[${this.name}] Failed to prefill candles:`, (err as Error).message);
    }

    console.log(
      `[${this.name}] active=${this.cfg.activeId} | trend=${this.cfg.trendCandleSize}s | entry=${this.cfg.entryCandleSize}s | ` +
      `exp=${this.cfg.baseExpirationSize}s` +
      (this.cfg.allowFastExpiry ? `/${this.cfg.fastExpirationSize}s` : "") +
      ` | $${this.cfg.tradeAmount} | minPayout=${this.cfg.minPayoutPercent}%` +
      (this.cfg.debug ? " | DEBUG ON" : "")
    );
  }

  async onObservation(obs: Observation): Promise<Action[]> {
    const now = safeNow(obs);
    if (this.stopTrading) return [];

    if (this.cfg.maxTotalLoss > 0 && obs.state.totalPnl <= -Math.abs(this.cfg.maxTotalLoss)) {
      this.stopTrading = true;
      console.log(`[${this.name}] STOP: maxTotalLoss reached (totalPnl=${obs.state.totalPnl.toFixed(2)})`);
      if (this.ctx) this.ctx.events.emit("agent:debug", { message: "maxTotalLoss reached", totalPnl: obs.state.totalPnl });
      return [];
    }

    if (now < this.pauseUntil) {
      this.dbg(`Paused for ${this.pauseUntil - now}s`);
      return [];
    }
    if (now < this.cooldownUntil) {
      this.dbg(`Cooldown for ${this.cooldownUntil - now}s`);
      return [];
    }
    if (obs.state.openPositions.length >= this.cfg.maxOpenTrades) {
      this.dbg(`Max open trades reached: ${obs.state.openPositions.length}/${this.cfg.maxOpenTrades}`);
      return [];
    }
    if (this.profitPercent < this.cfg.minPayoutPercent) {
      this.dbg(`Payout gate: profitPercent=${this.profitPercent} < min=${this.cfg.minPayoutPercent}`);
      return [];
    }

    const trendId = SensorManager.candleId(this.cfg.activeId, this.cfg.trendCandleSize);
    const entryId = SensorManager.candleId(this.cfg.activeId, this.cfg.entryCandleSize);
    const trendAll = obs.sensors.get(trendId) as Candle[] | undefined;
    const entryAll = obs.sensors.get(entryId) as Candle[] | undefined;
    if (!trendAll || !entryAll) return [];
    if (trendAll.length < 10 || entryAll.length < 10) return [];

    // Only act once per *new* entry candle open.
    const latestEntry = entryAll[entryAll.length - 1]!;
    if (latestEntry.from === this.lastEntryFrom) return [];
    this.lastEntryFrom = latestEntry.from;

    const trendCandles = trendAll.slice(0, -1);
    const entryCandles = entryAll.slice(0, -1);
    // Buffers are capped (live+backtest default ~100), so use derived minimums.
    const minTrend = Math.max(
      this.cfg.emaTrendPeriod + this.cfg.emaTrendSlopeLookback + 2,
      this.cfg.atrPeriod + 2,
    );
    const minEntry = Math.max(
      this.cfg.emaEntryPeriod + 2,
      this.cfg.atrPeriod + 2,
      this.cfg.swingLookback + 3,
    );
    if (trendCandles.length < minTrend) return [];
    if (entryCandles.length < minEntry) return [];

    const last = entryCandles[entryCandles.length - 1]!;

    // Deadtime gate
    const remainingBase = remainingInWindow(now, this.cfg.baseExpirationSize);
    if (remainingBase < this.cfg.deadtimeSeconds) {
      this.dbg(`Deadtime: ${remainingBase}s remaining (base window)`);
      return [];
    }

    // Trend direction + strength (trend timeframe)
    const trendCloses = trendCandles.map(c => c.close);
    const trendEma = ema(trendCloses, this.cfg.emaTrendPeriod);
    if (trendEma.length < this.cfg.emaTrendSlopeLookback + 2) return [];
    const emaNow = trendEma[trendEma.length - 1]!;
    const emaPrev = trendEma[trendEma.length - 1 - this.cfg.emaTrendSlopeLookback]!;
    const trendPrice = trendCloses[trendCloses.length - 1]!;
    const trendSlopePct = ((emaNow - emaPrev) / Math.max(1e-12, trendPrice)) * 100;
    const slopeAbs = Math.abs(trendSlopePct);
    if (slopeAbs < this.cfg.minTrendSlopePct) {
      this.dbg(`Trend gate: slopeAbs=${slopeAbs.toFixed(6)}% < min=${this.cfg.minTrendSlopePct}%`);
      this.pending = null;
      return [];
    }

    let trendDir: Direction | null = null;
    if (trendSlopePct > 0 && trendPrice >= emaNow) trendDir = "call";
    if (trendSlopePct < 0 && trendPrice <= emaNow) trendDir = "put";
    if (!trendDir) {
      this.dbg("Trend gate: price/EMA misaligned", { trendSlopePct, trendPrice, emaNow });
      this.pending = null;
      return [];
    }

    // Regime (ATR percentile + ATR%) on trend timeframe
    const trendAtrSeries = atr(trendCandles, this.cfg.atrPeriod);
    const trendAtrNow = trendAtrSeries[trendAtrSeries.length - 1] || 0;
    const atrPct = trendPrice > 0 ? (trendAtrNow / trendPrice) * 100 : 0;
    if (atrPct < this.cfg.atrPctMin || atrPct > this.cfg.atrPctMax) {
      this.dbg(`ATR% gate: ${atrPct.toFixed(4)}% outside [${this.cfg.atrPctMin}, ${this.cfg.atrPctMax}]`);
      this.pending = null;
      return [];
    }

    const wStart = Math.max(0, trendAtrSeries.length - this.cfg.atrWindow);
    const atrWindow = trendAtrSeries.slice(wStart);
    const atrRank = percentileRank(atrWindow, trendAtrNow);
    if (atrRank < this.cfg.atrPercentileMin || atrRank > this.cfg.atrPercentileMax) {
      this.dbg(`ATR rank gate: ${atrRank.toFixed(1)} outside [${this.cfg.atrPercentileMin}, ${this.cfg.atrPercentileMax}]`, {
        atrRank,
        trendAtrNow,
        atrPct,
      });
      this.pending = null;
      return [];
    }

    // Entry timeframe ATR + EMA
    const entryCloses = entryCandles.map(c => c.close);
    const entryEma = ema(entryCloses, this.cfg.emaEntryPeriod);
    const entryEmaNow = entryEma[entryEma.length - 1] || last.close;
    const entryAtrSeries = atr(entryCandles, this.cfg.atrPeriod);
    const entryAtrNow = entryAtrSeries[entryAtrSeries.length - 1] || 0;

    // Drop pending if trend flipped or stale
    if (this.pending && now >= this.pending.expiresAt) {
      this.dbg("Setup expired");
      this.pending = null;
    }
    if (this.pending && this.pending.direction !== trendDir) {
      this.dbg("Trend flipped; dropping setup");
      this.pending = null;
    }

    // No-chase gate (avoid trading when too extended from entry EMA)
    if (entryAtrNow > 0) {
      const extAtr = Math.abs(last.close - entryEmaNow) / entryAtrNow;
      if (extAtr > this.cfg.maxExtensionAtr) {
        this.dbg(`Extension gate: ext=${extAtr.toFixed(2)}ATR > max=${this.cfg.maxExtensionAtr}`);
        return [];
      }
    }

    // Build or consume setup (breakout -> retest+rejection)
    if (!this.pending) {
      const recent = entryCandles.slice(0, -1);
      if (recent.length < this.cfg.swingLookback + 2) return [];

      if (trendDir === "call") {
        const level = highestHigh(recent, this.cfg.swingLookback);
        const buffer = (this.cfg.breakoutBufferPct / 100) * level;
        // Breakout: wick makes a higher high and close confirms above the level.
        if (last.max > level + buffer && last.close > level && last.close > last.open) {
          const ttlSec = this.cfg.setupTtlCandles * this.cfg.entryCandleSize;
          this.pending = {
            direction: "call",
            level,
            createdAt: now,
            expiresAt: now + ttlSec,
            origin: "breakout",
          };
          this.dbg("Setup created CALL", { level, ttlSec, lastClose: last.close, lastHigh: last.max });
        }
      } else {
        const level = lowestLow(recent, this.cfg.swingLookback);
        const buffer = (this.cfg.breakoutBufferPct / 100) * level;
        // Breakout: wick makes a lower low and close confirms below the level.
        if (last.min < level - buffer && last.close < level && last.close < last.open) {
          const ttlSec = this.cfg.setupTtlCandles * this.cfg.entryCandleSize;
          this.pending = {
            direction: "put",
            level,
            createdAt: now,
            expiresAt: now + ttlSec,
            origin: "breakout",
          };
          this.dbg("Setup created PUT", { level, ttlSec, lastClose: last.close, lastLow: last.min });
        }
      }
      return [];
    }

    // Retest + rejection
    const level = this.pending.level;
    const prox = entryAtrNow > 0 ? this.cfg.retestProximityAtr * entryAtrNow : 0;
    const nearLevel = this.pending.direction === "call"
      ? (last.min <= level + prox)
      : (last.max >= level - prox);
    if (!nearLevel) {
      this.dbg("Waiting retest", { dir: this.pending.direction, level, close: last.close });
      return [];
    }

    // Level should be near the entry EMA (acts like dynamic support/resistance)
    if (entryAtrNow > 0) {
      const levelEmaDist = Math.abs(level - entryEmaNow) / entryAtrNow;
      if (levelEmaDist > this.cfg.levelEmaProximityAtr) {
        this.dbg(`Level/EMA mismatch: dist=${levelEmaDist.toFixed(2)}ATR > max=${this.cfg.levelEmaProximityAtr}`);
        return [];
      }
    }

    const bodyPct = candleBodyPct(last);
    if (bodyPct < this.cfg.retestMinBodyPct) {
      this.dbg(`Weak rejection: bodyPct=${bodyPct.toFixed(1)} < min=${this.cfg.retestMinBodyPct}`);
      return [];
    }

    const direction = this.pending.direction;
    let rejection = false;
    if (direction === "call") {
      rejection = last.min <= level + prox && last.close > level && last.close > last.open;
    } else {
      rejection = last.max >= level - prox && last.close < level && last.close < last.open;
    }
    if (!rejection) {
      this.dbg("No rejection yet", { direction, level, candle: { open: last.open, close: last.close, min: last.min, max: last.max } });
      return [];
    }

    // Determine expiry
    let expirationSize = this.cfg.baseExpirationSize;
    const impulse = entryAtrNow > 0
      ? (Math.abs(last.close - last.open) >= this.cfg.impulseAtrK * entryAtrNow)
      : false;
    const strongTrend = Math.abs(trendSlopePct) >= this.cfg.fastMinTrendSlopePct;
    const lowAtr = atrPct <= this.cfg.fastMaxAtrPct;
    if (this.cfg.allowFastExpiry && impulse && strongTrend && lowAtr) {
      const remainingFast = remainingInWindow(now, this.cfg.fastExpirationSize);
      if (remainingFast >= this.cfg.deadtimeSeconds) {
        expirationSize = this.cfg.fastExpirationSize;
      }
    }

    const remaining = remainingInWindow(now, expirationSize);
    if (remaining < this.cfg.deadtimeSeconds) {
      this.dbg(`Deadtime: ${remaining}s remaining (chosen window)`);
      return [];
    }

    const confidence = clamp(
      0.55 +
        Math.min(0.25, slopeAbs / Math.max(1e-12, this.cfg.fastMinTrendSlopePct) * 0.1) +
        (impulse ? 0.1 : 0),
      0,
      0.95,
    );

    if (this.ctx) {
      this.ctx.log.signal(direction, confidence, [
        `trendSlopePct=${trendSlopePct.toFixed(4)}%`,
        `atrRank=${atrRank.toFixed(1)}`,
        `atrPct=${atrPct.toFixed(4)}%`,
        `break+retest level=${level.toFixed(6)}`,
        impulse ? `impulse>=${this.cfg.impulseAtrK}ATR` : "noImpulse",
      ]);
    }

    console.log(
      `[${this.name}] ${direction.toUpperCase()} $${this.cfg.tradeAmount} | ` +
      `exp=${expirationSize}s (${remaining}s left) | level=${level.toFixed(6)} close=${last.close.toFixed(6)} | ` +
      `slope=${trendSlopePct.toFixed(4)}% atrRank=${atrRank.toFixed(1)} atr%=${atrPct.toFixed(4)}%`
    );

    this.pending = null;
    this.cooldownUntil = now + this.cfg.cooldownAfterTrade;

    return [
      {
        type: "trade",
        payload: {
          activeId: this.cfg.activeId,
          direction,
          price: this.cfg.tradeAmount,
          balanceId: this.balanceId,
          expirationSize,
          profitPercent: clamp(this.profitPercent, 0, 100),
          currentPrice: last.close,
        } as Record<string, unknown>,
      },
    ];
  }

  onTradeResult(position: Position): void {
    const isWin = position.close_reason === "win";
    if (isWin) {
      this.consecutiveLosses = 0;
      return;
    }

    this.consecutiveLosses++;
    if (this.consecutiveLosses >= this.cfg.maxConsecutiveLosses) {
      this.pauseUntil = (this.ctx?.now() ?? Math.floor(Date.now() / 1000)) + this.cfg.lossPauseDuration; // lint:allow-date-now — fallback only
      console.log(`[${this.name}] PAUSED after ${this.consecutiveLosses} losses | resume in ${this.cfg.lossPauseDuration}s`);
      if (this.ctx) this.ctx.events.emit("agent:debug", { message: "paused on loss streak", losses: this.consecutiveLosses });
    }
  }
}

export function createAgent(config: Record<string, unknown>): Agent {
  const merged: ATRXAgentConfig = {
    ...DEFAULT_ATRX_CONFIG,
    ...config,
  } as ATRXAgentConfig;

  return new ATRXAgent(merged);
}
