import { Hono } from "hono";
import { db } from "../db/index.ts";
import { events } from "../db/schema.ts";
import { eq, desc, and, gte, lte } from "drizzle-orm";

const app = new Hono()
  .get("/", async (c) => {
    const runId = c.req.query("runId");
    const type = c.req.query("type");
    const from = c.req.query("from");
    const to = c.req.query("to");
    const limit = Number(c.req.query("limit") || "100");
    const offset = Number(c.req.query("offset") || "0");

    const conditions = [];
    if (runId) conditions.push(eq(events.runId, runId));
    if (type) conditions.push(eq(events.type, type));
    if (from) conditions.push(gte(events.timestamp, Number(from)));
    if (to) conditions.push(lte(events.timestamp, Number(to)));

    const rows = await db
      .select()
      .from(events)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(events.timestamp))
      .limit(limit)
      .offset(offset);

    return c.json(rows);
  });

export default app;
