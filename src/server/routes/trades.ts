import { Hono } from "hono";
import { db } from "../db/index.ts";
import { trades } from "../db/schema.ts";
import { eq, desc, and } from "drizzle-orm";

const app = new Hono()
  .get("/", async (c) => {
    const runId = c.req.query("runId");
    const result = c.req.query("result") as "win" | "loss" | undefined;

    const conditions = [];
    if (runId) conditions.push(eq(trades.runId, runId));
    if (result) conditions.push(eq(trades.result, result));

    const rows = await db
      .select()
      .from(trades)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(trades.placedAt));

    return c.json(rows);
  })
  .post("/", async (c) => {
    const body = await c.req.json();
    const result = await db.insert(trades).values(body).returning();
    return c.json(result[0], 201);
  })
  .patch("/:id", async (c) => {
    const body = await c.req.json();
    await db
      .update(trades)
      .set(body)
      .where(eq(trades.id, Number(c.req.param("id"))));
    return c.json({ ok: true });
  });

export default app;
