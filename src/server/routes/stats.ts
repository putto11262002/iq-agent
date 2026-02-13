import { Hono } from "hono";
import { db } from "../db/index.ts";
import { runs, trades, snapshots } from "../db/schema.ts";
import { eq, desc, inArray, sql } from "drizzle-orm";

async function computeRunStats(runId: string) {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
  if (!run) return null;

  const tradeRows = await db.select().from(trades).where(eq(trades.runId, runId));
  const wins = tradeRows.filter((t) => t.result === "win").length;
  const losses = tradeRows.filter((t) => t.result === "loss").length;
  const total = wins + losses;
  const winRate = total > 0 ? (wins / total) * 100 : 0;
  const totalPnl = tradeRows.reduce((sum, t) => sum + (t.pnl ?? 0), 0);

  const lastSnap = await db
    .select()
    .from(snapshots)
    .where(eq(snapshots.runId, runId))
    .orderBy(desc(snapshots.ts))
    .limit(1);

  const duration = (run.stoppedAt ?? Math.floor(Date.now() / 1000)) - run.startedAt;

  return {
    runId,
    agentType: run.agentType,
    agentId: run.agentId,
    status: run.status,
    startBalance: run.startBalance,
    currentBalance: lastSnap[0]?.wallet ?? run.startBalance,
    totalTrades: total,
    wins,
    losses,
    winRate: Math.round(winRate * 10) / 10,
    totalPnl: Math.round(totalPnl * 100) / 100,
    maxDrawdown: Math.round((lastSnap[0]?.drawdown ?? 0) * 100) / 100,
    durationSec: duration,
  };
}

const app = new Hono()
  .get("/compare", async (c) => {
    const idsParam = c.req.query("ids");
    if (!idsParam) return c.json({ error: "Provide ?ids=run1,run2,..." }, 400);
    const ids = idsParam.split(",");
    const results = await Promise.all(ids.map(computeRunStats));
    return c.json(results.filter(Boolean));
  })
  .get("/leaderboard", async (c) => {
    const sortBy = c.req.query("sort") || "pnl";
    const allRuns = await db.select().from(runs).orderBy(desc(runs.startedAt));
    const stats = await Promise.all(allRuns.map((r) => computeRunStats(r.id)));
    const valid = stats.filter(Boolean) as NonNullable<Awaited<ReturnType<typeof computeRunStats>>>[];

    if (sortBy === "winRate") {
      valid.sort((a, b) => b.winRate - a.winRate);
    } else {
      valid.sort((a, b) => b.totalPnl - a.totalPnl);
    }

    return c.json(valid);
  })
  .get("/summary", async (c) => {
    const allRuns = await db.select().from(runs);
    const allTrades = await db.select().from(trades);

    const running = allRuns.filter((r) => r.status === "running").length;
    const stopped = allRuns.filter((r) => r.status === "stopped").length;
    const totalTrades = allTrades.length;
    const wins = allTrades.filter((t) => t.result === "win").length;
    const losses = allTrades.filter((t) => t.result === "loss").length;
    const totalPnl = allTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);

    return c.json({
      totalRuns: allRuns.length,
      running,
      stopped,
      totalTrades,
      wins,
      losses,
      winRate: totalTrades > 0 ? Math.round((wins / (wins + losses)) * 1000) / 10 : 0,
      totalPnl: Math.round(totalPnl * 100) / 100,
    });
  });

export default app;
