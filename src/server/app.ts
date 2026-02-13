import { Hono } from "hono";
import runs from "./routes/runs.ts";
import trades from "./routes/trades.ts";
import wallets from "./routes/wallets.ts";
import stats from "./routes/stats.ts";
import agentsRoute from "./routes/agents.ts";
import eventsRoute from "./routes/events.ts";

const app = new Hono();

const routes = app
  .route("/api/runs", runs)
  .route("/api/trades", trades)
  .route("/api/wallets", wallets)
  .route("/api/stats", stats)
  .route("/api/agents", agentsRoute)
  .route("/api/events", eventsRoute);

export default app;
export type AppType = typeof routes;
