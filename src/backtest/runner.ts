import { db } from "../server/db/index.ts";
import { datasets, datasetCandles } from "../server/db/schema.ts";
import { eq, asc } from "drizzle-orm";
import type { Candle, BlitzOptionConfig } from "../types/index.ts";
import { Wallet } from "../bot/infra/wallet.ts";
import { EventBus, createEventPersister } from "../events/index.ts";
import { createAgentContext } from "../env/agent-context.ts";
import { apiFetch } from "../cli/api.ts";
import { BacktestEnvironment } from "./environment.ts";
import type { BacktestConfig, BacktestResult, PendingTrade } from "./types.ts";
import type { Agent } from "../env/types.ts";

export class BacktestRunner {
  private config: BacktestConfig;

  constructor(config: BacktestConfig) {
    this.config = config;
  }

  async run(agent: Agent): Promise<BacktestResult> {
    // 1. Load dataset(s)
    const allCandles: Candle[] = [];
    let assetConfig: BlitzOptionConfig | null = null;
    let payoutPercent = this.config.payoutPercent ?? 80;

    for (const dsName of this.config.datasetNames) {
      const ds = await db.query.datasets.findFirst({
        where: eq(datasets.name, dsName),
      });

      if (!ds) {
        throw new Error(`Dataset "${dsName}" not found`);
      }

      // Get asset config + payout from first dataset
      if (!assetConfig && ds.assetConfig) {
        assetConfig = ds.assetConfig as unknown as BlitzOptionConfig;
        if (!this.config.payoutPercent && assetConfig.profit_commission != null) {
          payoutPercent = 100 - (assetConfig.profit_commission as number);
        }
      }

      const rows = await db
        .select()
        .from(datasetCandles)
        .where(eq(datasetCandles.dataset, dsName))
        .orderBy(asc(datasetCandles.from));

      for (const row of rows) {
        allCandles.push({
          id: row.id,
          from: row.from,
          to: row.to,
          open: row.open,
          close: row.close,
          min: row.min,
          max: row.max,
          low: row.min,
          high: row.max,
          volume: row.volume,
          active_id: row.activeId,
          size: row.size,
          at: row.from,
        } as Candle);
      }
    }

    if (allCandles.length === 0) {
      throw new Error("No candles found in dataset(s)");
    }

    // Sort all candles chronologically
    allCandles.sort((a, b) => a.from - b.from);

    // 2. Create Wallet + EventBus
    const wallet = new Wallet({ mode: "virtual", initialBalance: this.config.initialBalance });

    const ts = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const rand = Math.random().toString(36).slice(2, 5);
    const runId = `bt-${this.config.agentName}-${ts}-${rand}`;

    let simulatedTime = allCandles[0]!.from;
    const eventBus = new EventBus(runId, () => simulatedTime);

    // 3. Wire event persistence
    try {
      const persister = createEventPersister();
      eventBus.setPersist(persister);
    } catch {
      // Server may not be running — skip
    }

    // 4. Create environment
    const env = new BacktestEnvironment({
      allCandles,
      wallet,
      eventBus,
      assetConfig,
      payoutPercent,
    });

    // 5. Wire trade recording — record each resolved trade to server (matches live AgentRunner pattern)
    let wins = 0;
    let losses = 0;
    let ties = 0;
    let totalPnl = 0;

    env.onTradeResolved((trade: PendingTrade, result: "win" | "loss" | "tie", pnl: number, closePrice: number) => {
      if (result === "win") wins++;
      else if (result === "loss") losses++;
      else ties++;
      totalPnl += pnl;

      // Record trade to server (fire-and-forget, matches live runner pattern)
      apiFetch("/api/trades", "POST", {
        runId,
        placedAt: trade.openTime,
        direction: trade.direction,
        amount: trade.invest,
        activeId: trade.activeId,
        expiration: trade.expirationTime,
        entryPrice: trade.openQuote,
        exitPrice: closePrice,
        result: result === "tie" ? "loss" : result, // DB schema only supports win/loss
        pnl,
        closedAt: simulatedTime,
        walletAfter: wallet.getBalance(),
      }).catch(() => {
        // Server may not be running — silently skip
      });
    });

    // 6. Register run in server
    try {
      await apiFetch("/api/runs", "POST", {
        id: runId,
        agentType: `backtest:${this.config.agentName}`,
        agentId: this.config.agentName,
        config: this.config.agentConfig,
        walletMode: "virtual",
        startBalance: this.config.initialBalance,
        startedAt: Math.floor(Date.now() / 1000),
        status: "running",
      });
    } catch {
      // Server may not be running
    }

    // 7. Emit run:started
    eventBus.emit("run:started", {
      agentType: `backtest:${this.config.agentName}`,
      agentId: this.config.agentName,
      config: this.config.agentConfig,
    });

    // 8. Initialize agent — set currentTime to first candle so prefill works
    // [FIX m8] runAgent() sets agentRef internally — no separate setAgent() needed
    env.setCurrentTime(allCandles[0]!.from);
    const ctx = createAgentContext({ eventBus, wallet, runId, timeFn: () => simulatedTime });
    await env.runAgent(agent, ctx);

    // 9. Main loop — replay candles
    let busted = false;
    wallet.onBust(() => { busted = true; });

    const totalCandles = allCandles.length;
    const progressInterval = Math.max(1, Math.floor(totalCandles / 20));
    // Wallet snapshots every ~500 candles (periodic, matching live runner's 30s interval concept)
    const snapshotInterval = Math.max(1, Math.min(500, Math.floor(totalCandles / 40)));

    for (let i = 0; i < totalCandles; i++) {
      if (busted) break;

      const candle = allCandles[i]!;
      simulatedTime = candle.from;
      env.setCurrentTime(candle.from);
      env.checkExpirations();
      await env.feedCandle(candle);

      // Progress output
      if (i > 0 && i % progressInterval === 0) {
        const pct = ((i / totalCandles) * 100).toFixed(0);
        process.stdout.write(
          `\r  [${pct}%] ${i}/${totalCandles} candles | ${wins}W ${losses}L${ties > 0 ? ` ${ties}T` : ""} | $${wallet.getBalance().toFixed(2)}`,
        );
      }

      // Periodic wallet snapshots
      if (i > 0 && i % snapshotInterval === 0) {
        const walletSnap = wallet.snapshot();
        apiFetch(`/api/wallets/${runId}/snapshot`, "POST", {
          ts: simulatedTime,
          wallet: walletSnap.balance,
          wins,
          losses,
          totalPnl: Math.round(totalPnl * 100) / 100,
          drawdown: Math.round(walletSnap.maxDrawdown * 100) / 100,
        }).catch(() => {
          // Server may not be running
        });
      }
    }

    // 10. Force-close remaining trades at last candle price
    if (allCandles.length > 0) {
      const lastCandle = allCandles[allCandles.length - 1]!;
      env.forceCloseAll(lastCandle.close);
    }

    // Clear progress line
    process.stdout.write("\r" + " ".repeat(80) + "\r");

    // 11. Final wallet snapshot
    const walletSnap = wallet.snapshot();
    apiFetch(`/api/wallets/${runId}/snapshot`, "POST", {
      ts: simulatedTime,
      wallet: walletSnap.balance,
      wins,
      losses,
      totalPnl: Math.round(totalPnl * 100) / 100,
      drawdown: Math.round(walletSnap.maxDrawdown * 100) / 100,
    }).catch(() => {});

    // 12. Emit run:stopped
    const snap = env.state.snapshot();
    eventBus.emit("run:stopped", {
      reason: busted ? "bust" : "complete",
      totalTrades: wins + losses + ties,
      pnl: totalPnl,
    });

    // 13. Update run status in server
    try {
      await apiFetch(`/api/runs/${runId}`, "PATCH", {
        status: "stopped",
        stoppedAt: Math.floor(Date.now() / 1000),
        stopReason: busted ? "bust" : "complete",
      });
    } catch {
      // Server may not be running
    }

    // 14. Build result
    const totalTrades = wins + losses + ties;
    const result: BacktestResult = {
      runId,
      trades: totalTrades,
      wins,
      losses,
      winRate: totalTrades > 0
        ? Math.round((wins / totalTrades) * 10000) / 100
        : 0,
      pnl: Math.round(totalPnl * 100) / 100,
      maxDrawdown: Math.round(wallet.getMaxDrawdown() * 100) / 100,
      finalBalance: Math.round(wallet.getBalance() * 100) / 100,
      durationCandles: allCandles.length,
    };

    return result;
  }
}
