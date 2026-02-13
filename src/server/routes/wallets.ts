import { Hono } from "hono";
import { db } from "../db/index.ts";
import { snapshots, runs } from "../db/schema.ts";
import { eq, desc } from "drizzle-orm";

const app = new Hono()
  .get("/:runId", async (c) => {
    const runId = c.req.param("runId");
    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (!run) return c.json({ error: "Run not found" }, 404);

    const lastSnap = await db
      .select()
      .from(snapshots)
      .where(eq(snapshots.runId, runId))
      .orderBy(desc(snapshots.ts))
      .limit(1);

    return c.json({
      runId,
      balance: lastSnap[0]?.wallet ?? run.startBalance,
      drawdown: lastSnap[0]?.drawdown ?? 0,
      wins: lastSnap[0]?.wins ?? 0,
      losses: lastSnap[0]?.losses ?? 0,
      totalPnl: lastSnap[0]?.totalPnl ?? 0,
    });
  })
  .post("/:runId/snapshot", async (c) => {
    const body = await c.req.json();
    await db.insert(snapshots).values({
      runId: c.req.param("runId"),
      ...body,
    });
    return c.json({ ok: true }, 201);
  });

export default app;
