import { Hono } from "hono";
import { db } from "../db/index.ts";
import { agents } from "../db/schema.ts";
import { eq } from "drizzle-orm";

const app = new Hono()
  .get("/", async (c) => {
    const rows = await db.select().from(agents);
    return c.json(rows);
  })
  .get("/:name", async (c) => {
    const row = await db.query.agents.findFirst({
      where: eq(agents.name, c.req.param("name")),
    });
    if (!row) return c.json({ error: "Agent not found" }, 404);
    return c.json(row);
  })
  .post("/", async (c) => {
    const body = await c.req.json();
    await db.insert(agents).values({
      name: body.name,
      path: body.path,
      description: body.description ?? null,
      defaultConfig: body.defaultConfig ?? null,
      createdAt: Math.floor(Date.now() / 1000),
    });
    return c.json({ ok: true, name: body.name }, 201);
  })
  .delete("/:name", async (c) => {
    const name = c.req.param("name");
    await db.delete(agents).where(eq(agents.name, name));
    return c.json({ ok: true });
  });

export default app;
