import { Hono } from "hono";
import { db } from "../db/index.ts";
import { runs, trades, snapshots } from "../db/schema.ts";
import { eq, desc, and, gte, lte, sql } from "drizzle-orm";

const app = new Hono()
  .get("/", async (c) => {
    const status = c.req.query("status") as "running" | "stopped" | undefined;
    const agentType = c.req.query("agentType");
    const from = c.req.query("from");
    const to = c.req.query("to");

    const conditions = [];
    if (status) conditions.push(eq(runs.status, status));
    if (agentType) conditions.push(eq(runs.agentType, agentType));
    if (from) conditions.push(gte(runs.startedAt, Number(from)));
    if (to) conditions.push(lte(runs.startedAt, Number(to)));

    const rows = await db
      .select()
      .from(runs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(runs.startedAt));

    return c.json(rows);
  })
  .get("/:id", async (c) => {
    const row = await db.query.runs.findFirst({
      where: eq(runs.id, c.req.param("id")),
    });
    if (!row) return c.json({ error: "Run not found" }, 404);
    return c.json(row);
  })
  .post("/", async (c) => {
    const body = await c.req.json();
    await db.insert(runs).values(body);
    return c.json({ ok: true, id: body.id }, 201);
  })
  .patch("/:id", async (c) => {
    const body = await c.req.json();
    await db.update(runs).set(body).where(eq(runs.id, c.req.param("id")));
    return c.json({ ok: true });
  })
  .get("/:id/stats", async (c) => {
    const runId = c.req.param("id");
    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (!run) return c.json({ error: "Run not found" }, 404);

    const tradeRows = await db
      .select()
      .from(trades)
      .where(eq(trades.runId, runId));

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

    const maxDrawdown = lastSnap[0]?.drawdown ?? 0;
    const currentBalance = lastSnap[0]?.wallet ?? run.startBalance;

    const duration = (run.stoppedAt ?? Math.floor(Date.now() / 1000)) - run.startedAt;

    return c.json({
      runId,
      agentType: run.agentType,
      agentId: run.agentId,
      status: run.status,
      walletMode: run.walletMode,
      startBalance: run.startBalance,
      currentBalance,
      totalTrades: total,
      wins,
      losses,
      winRate: Math.round(winRate * 10) / 10,
      totalPnl: Math.round(totalPnl * 100) / 100,
      maxDrawdown: Math.round(maxDrawdown * 100) / 100,
      durationSec: duration,
      startedAt: run.startedAt,
      stoppedAt: run.stoppedAt,
    });
  });

export default app;
