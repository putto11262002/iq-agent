import { IQWebSocket } from "../../client/ws.ts";
import { Protocol } from "../../client/protocol.ts";
import { login, authenticateWs } from "../../client/auth.ts";
import { AccountAPI } from "../../api/account.ts";
import { AssetsAPI } from "../../api/assets.ts";
import { CandlesAPI } from "../../api/candles.ts";
import { TradingAPI } from "../../api/trading.ts";
import { SubscriptionsAPI } from "../../api/subscriptions.ts";
import { TradingEnvironment } from "../../env/environment.ts";
import { Wallet, type WalletConfig } from "./wallet.ts";
import { EventBus, createEventPersister } from "../../events/index.ts";
import { createAgentContext } from "../../env/agent-context.ts";
import { apiFetch } from "../../cli/api.ts";
import type { Agent } from "../../env/types.ts";
import type { Position } from "../../types/index.ts";

export interface RunnerConfig {
  profile?: string;
  accountMode?: "demo" | "real";
  ssid?: string;
  credentials?: { email: string; password: string };
  agent: Agent;
  agentId: string;
  agentType: string;
  agentConfig: Record<string, unknown>;
  wallet: WalletConfig;
  maxDuration?: number;
}

export class AgentRunner {
  private cfg: RunnerConfig;
  private wallet: Wallet;
  private runId: string;
  private running = false;
  private ws: IQWebSocket | null = null;
  private wins = 0;
  private losses = 0;
  private totalPnl = 0;
  private snapshotInterval: ReturnType<typeof setInterval> | null = null;
  private durationTimeout: ReturnType<typeof setTimeout> | null = null;
  private eventBus: EventBus;

  constructor(cfg: RunnerConfig) {
    this.cfg = cfg;
    this.wallet = new Wallet(cfg.wallet);

    const ts = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const rand = Math.random().toString(36).slice(2, 5);
    this.runId = `${cfg.agentType}-${cfg.agentId}-${ts}-${rand}`;

    this.eventBus = new EventBus(this.runId);
  }

  getRunId(): string {
    return this.runId;
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    // 1. Register run in server
    try {
      await apiFetch("/api/runs", "POST", {
        id: this.runId,
        agentType: this.cfg.agentType,
        agentId: this.cfg.agentId,
        config: this.cfg.agentConfig,
        walletMode: this.cfg.wallet.mode,
        startBalance: this.cfg.wallet.initialBalance,
        startedAt: Math.floor(Date.now() / 1000),
        status: "running",
        profileName: this.cfg.profile ?? null,
        accountMode: this.cfg.accountMode ?? "demo",
      });
      console.log(`[Runner] Registered run: ${this.runId}`);
    } catch (err) {
      console.warn(`[Runner] Could not register run with server (is it running?): ${(err as Error).message}`);
    }

    // 2. Wire event persistence (fire-and-forget, tolerant of server being down)
    try {
      const persister = createEventPersister();
      this.eventBus.setPersist(persister);
    } catch (err) {
      console.warn(`[Runner] Event persistence unavailable: ${(err as Error).message}`);
    }

    // 3. Emit run:started
    this.eventBus.emit("run:started", {
      agentType: this.cfg.agentType,
      agentId: this.cfg.agentId,
      config: this.cfg.agentConfig,
    });

    // 4. Boot WS → auth → env (fallback chain: profile → ssid → credentials → env)
    let ssid = "";
    if (this.cfg.profile) {
      // Resolve SSID via server-managed auth profile
      try {
        const profileRes = await apiFetch(`/api/auth/profiles/${encodeURIComponent(this.cfg.profile)}/ssid`, "POST");
        if (!profileRes.ok) {
          const err = await profileRes.json() as { error?: string };
          throw new Error(err.error || `Profile "${this.cfg.profile}" SSID fetch failed`);
        }
        const data = await profileRes.json() as { ssid: string; cached: boolean };
        ssid = data.ssid;
        console.log(`[Runner] Auth via profile "${this.cfg.profile}" (cached=${data.cached})`);
      } catch (err) {
        throw new Error(`Profile auth failed: ${(err as Error).message}`);
      }
    } else if (this.cfg.ssid) {
      ssid = this.cfg.ssid;
    } else if (this.cfg.credentials) {
      const result = await login(this.cfg.credentials.email, this.cfg.credentials.password);
      ssid = result.ssid;
    } else if (process.env.IQ_EMAIL && process.env.IQ_PASSWORD) {
      const result = await login(process.env.IQ_EMAIL, process.env.IQ_PASSWORD);
      ssid = result.ssid;
    } else {
      throw new Error("No auth method available: provide --profile, ssid, credentials, or IQ_EMAIL+IQ_PASSWORD env vars");
    }

    this.ws = new IQWebSocket();
    await this.ws.connect();
    const protocol = new Protocol(this.ws);
    await authenticateWs(protocol, ssid);

    const account = new AccountAPI(protocol, this.ws);
    const assets = new AssetsAPI(protocol);
    const candles = new CandlesAPI(protocol, this.ws);
    const trading = new TradingAPI(protocol, this.ws);
    const subscriptions = new SubscriptionsAPI(protocol, this.ws);

    const env = new TradingEnvironment(protocol, this.ws, account, assets, candles, trading, subscriptions);
    env.setSsid(ssid);
    env.setEventBus(this.eventBus);
    await env.initialize(this.cfg.accountMode ?? "demo");

    this.running = true;

    // 5. Wire wallet bust detection
    this.wallet.onBust(() => {
      console.log(`[Runner] Wallet busted — stopping run`);
      this.stop("bust");
    });

    // 6. Subscribe to position changes directly — no monkey-patching
    //    Note: agent.onTradeResult is now called by the environment in runAgent()
    trading.onPositionChanged((pos: Position) => {
      if (pos.status === "closed") {
        this.handleTradeResult(pos);
      }
    });

    // 7. Create AgentContext and run agent
    const ctx = createAgentContext({
      eventBus: this.eventBus,
      wallet: this.wallet,
      runId: this.runId,
    });
    await env.runAgent(this.cfg.agent, ctx);
    console.log(`[Runner] Agent ${this.cfg.agent.name} running. Run ID: ${this.runId}`);

    // 8. Periodic snapshots every 30s
    this.snapshotInterval = setInterval(() => this.sendSnapshot(), 30_000);

    // 9. Max duration timeout
    if (this.cfg.maxDuration) {
      this.durationTimeout = setTimeout(() => {
        console.log(`[Runner] Max duration (${this.cfg.maxDuration}s) reached`);
        this.stop("timeout");
      }, this.cfg.maxDuration * 1000);
    }

    // 10. Handle SIGINT
    process.on("SIGINT", () => {
      console.log("\n[Runner] Shutting down...");
      this.stop("user");
    });
  }

  async stop(reason: string): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.snapshotInterval) clearInterval(this.snapshotInterval);
    if (this.durationTimeout) clearTimeout(this.durationTimeout);

    // Emit run:stopped
    this.eventBus.emit("run:stopped", {
      reason,
      totalTrades: this.wins + this.losses,
      pnl: this.totalPnl,
    });

    // Send final snapshot
    await this.sendSnapshot();

    // Update run in server
    try {
      await apiFetch(`/api/runs/${this.runId}`, "PATCH", {
        status: "stopped",
        stoppedAt: Math.floor(Date.now() / 1000),
        stopReason: reason,
      });
      console.log(`[Runner] Run ${this.runId} stopped (${reason})`);
    } catch (err) {
      console.warn(`[Runner] Could not update run status: ${(err as Error).message}`);
    }

    // Print summary
    const total = this.wins + this.losses;
    const wr = total > 0 ? ((this.wins / total) * 100).toFixed(1) : "0.0";
    const snap = this.wallet.snapshot();
    console.log(
      `\n[Runner] SUMMARY | ${total} trades | ${this.wins}W ${this.losses}L | WR ${wr}% | ` +
      `PnL ${this.totalPnl >= 0 ? "+" : ""}${this.totalPnl.toFixed(2)} | ` +
      `wallet $${snap.balance.toFixed(2)} | maxDD $${snap.maxDrawdown.toFixed(2)}\n`
    );

    if (this.ws) this.ws.close();
    process.exit(0);
  }

  private handleTradeResult(position: Position): void {
    const isWin = position.close_reason === "win";
    const amount = position.invest;
    const pnl = position.pnl_realized ?? position.pnl ?? 0;
    const previousBalance = this.wallet.getBalance();

    if (isWin) {
      this.wins++;
      this.wallet.credit(pnl);
    } else {
      this.losses++;
      this.wallet.debit(amount);
    }
    this.totalPnl += pnl;

    const label = isWin ? "WIN" : "LOSS";
    const pnlSign = pnl >= 0 ? "+" : "";
    console.log(
      `[Runner] ${label} ${pnlSign}${pnl.toFixed(2)} | ${this.wins}W ${this.losses}L | PnL ${this.totalPnl >= 0 ? "+" : ""}${this.totalPnl.toFixed(2)} | wallet $${this.wallet.getBalance().toFixed(2)}`
    );

    // Emit trade:closed event
    this.eventBus.emit("trade:closed", {
      positionId: position.id,
      direction: position.direction,
      result: isWin ? "win" : "loss",
      pnl,
      invest: amount,
    });

    // Emit wallet:changed event
    this.eventBus.emit("wallet:changed", {
      balance: this.wallet.getBalance(),
      previousBalance,
      reason: isWin ? "trade:win" : "trade:loss",
    });

    // Record trade in server
    const tradeData = {
      runId: this.runId,
      placedAt: position.open_time,
      direction: (position.direction ?? "call") as "call" | "put",
      amount,
      activeId: position.active_id,
      expiration: position.expiration_time ?? 0,
      entryPrice: position.open_quote,
      exitPrice: position.close_quote ?? null,
      result: (isWin ? "win" : "loss") as "win" | "loss",
      pnl,
      closedAt: position.close_time ?? Math.floor(Date.now() / 1000),
      walletAfter: this.wallet.getBalance(),
    };

    apiFetch("/api/trades", "POST", tradeData).catch((err) => {
      console.warn(`[Runner] Could not record trade: ${(err as Error).message}`);
    });
  }

  private async sendSnapshot(): Promise<void> {
    const snap = this.wallet.snapshot();
    try {
      await apiFetch(`/api/wallets/${this.runId}/snapshot`, "POST", {
        ts: Math.floor(Date.now() / 1000),
        wallet: snap.balance,
        wins: this.wins,
        losses: this.losses,
        totalPnl: Math.round(this.totalPnl * 100) / 100,
        drawdown: Math.round(snap.maxDrawdown * 100) / 100,
      });
    } catch {
      // Server might not be running — silently skip
    }
  }
}
