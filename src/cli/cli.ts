import { api, apiFetch } from "./api.ts";

const [command, ...args] = process.argv.slice(2);

function pad(s: string, n: number) {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

// Color helpers for terminal output
const colors = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function colorForEventType(type: string): (s: string) => string {
  if (type.startsWith("trade:")) return colors.green;
  if (type.startsWith("wallet:")) return colors.yellow;
  if (type.startsWith("agent:")) return colors.cyan;
  if (type.startsWith("run:")) return colors.bold;
  if (type.startsWith("action:failed")) return colors.red;
  if (type.startsWith("action:")) return colors.blue;
  if (type.startsWith("ws:")) return colors.magenta;
  if (type.startsWith("position:")) return colors.gray;
  return (s: string) => s;
}

// ─── Existing Commands ───

async function list() {
  const status = args[0] as "running" | "stopped" | undefined;
  const query: Record<string, string> = {};
  if (status) query.status = status;

  const res = await api.api.runs.$get({ query });
  const runs = await res.json();

  if (!Array.isArray(runs) || runs.length === 0) {
    console.log("No runs found.");
    return;
  }

  console.log(
    `\n  ${pad("ID", 32)} | ${pad("Agent", 10)} | ${pad("Status", 8)} | ${pad("Balance", 10)} | Started`
  );
  console.log("  " + "-".repeat(90));
  for (const r of runs) {
    const started = new Date(r.startedAt * 1000).toLocaleString();
    console.log(
      `  ${pad(r.id, 32)} | ${pad(r.agentType, 10)} | ${pad(r.status ?? "running", 8)} | $${pad(String(r.startBalance), 9)} | ${started}`
    );
  }
  console.log(`\n  Total: ${runs.length} runs\n`);
}

async function stats(runId: string) {
  if (!runId) {
    console.error("Usage: cli stats <runId>");
    return;
  }
  const res = await api.api.runs[":id"].stats.$get({ param: { id: runId } });
  if (res.status === 404) {
    console.error(`Run "${runId}" not found.`);
    return;
  }
  const s = await res.json() as Record<string, unknown>;

  console.log(`\n  Run: ${s.runId}`);
  console.log(`  Agent: ${s.agentType} (${s.agentId})`);
  console.log(`  Status: ${s.status}`);
  console.log(`  Wallet: $${s.startBalance} → $${s.currentBalance}`);
  console.log(`  Trades: ${s.totalTrades} (${s.wins}W / ${s.losses}L)`);
  console.log(`  Win Rate: ${s.winRate}%`);
  console.log(`  PnL: ${Number(s.totalPnl) >= 0 ? "+" : ""}$${s.totalPnl}`);
  console.log(`  Max Drawdown: $${s.maxDrawdown}`);
  console.log(`  Duration: ${fmtDuration(s.durationSec as number)}`);
  console.log();
}

async function compare(...ids: string[]) {
  if (ids.length < 2) {
    console.error("Usage: cli compare <id1> <id2> [id3...]");
    return;
  }
  const res = await api.api.stats.compare.$get({ query: { ids: ids.join(",") } });
  const rows = await res.json() as Record<string, unknown>[];

  if (!Array.isArray(rows) || rows.length === 0) {
    console.log("No matching runs found.");
    return;
  }

  const fields = ["runId", "agentType", "status", "totalTrades", "wins", "losses", "winRate", "totalPnl", "maxDrawdown", "currentBalance"];
  const colW = 20;

  console.log("\n  " + pad("Metric", 16) + rows.map((r) => pad(String(r.runId).slice(0, colW), colW)).join(" "));
  console.log("  " + "-".repeat(16 + rows.length * colW));

  for (const f of fields) {
    const label = pad(f, 16);
    const vals = rows.map((r) => pad(String(r[f] ?? "-"), colW)).join(" ");
    console.log("  " + label + vals);
  }
  console.log();
}

async function listTrades(runId: string) {
  if (!runId) {
    console.error("Usage: cli trades <runId>");
    return;
  }
  const res = await api.api.trades.$get({ query: { runId } });
  const rows = await res.json();

  if (!Array.isArray(rows) || rows.length === 0) {
    console.log("No trades found.");
    return;
  }

  console.log(
    `\n  ${pad("Time", 20)} | ${pad("Dir", 5)} | ${pad("Amount", 8)} | ${pad("Result", 6)} | ${pad("PnL", 10)} | Wallet`
  );
  console.log("  " + "-".repeat(75));
  for (const t of rows) {
    const time = new Date((t.placedAt) * 1000).toLocaleString();
    console.log(
      `  ${pad(time, 20)} | ${pad(t.direction, 5)} | $${pad(String(t.amount), 7)} | ${pad(t.result ?? "open", 6)} | ${pad(t.pnl != null ? (t.pnl >= 0 ? "+" : "") + t.pnl.toFixed(2) : "-", 10)} | $${t.walletAfter?.toFixed(2) ?? "-"}`
    );
  }
  console.log(`\n  Total: ${rows.length} trades\n`);
}

async function leaderboard() {
  const sort = args[0] || "pnl";
  const res = await api.api.stats.leaderboard.$get({ query: { sort } });
  const rows = await res.json() as Record<string, unknown>[];

  if (!Array.isArray(rows) || rows.length === 0) {
    console.log("No runs found.");
    return;
  }

  console.log(
    `\n  # | ${pad("Run ID", 30)} | ${pad("Agent", 8)} | ${pad("Trades", 7)} | ${pad("WR%", 6)} | ${pad("PnL", 10)} | DD`
  );
  console.log("  " + "-".repeat(85));
  rows.forEach((r, i) => {
    const pnl = Number(r.totalPnl);
    console.log(
      `  ${pad(String(i + 1), 2)}| ${pad(String(r.runId).slice(0, 30), 30)} | ${pad(String(r.agentType), 8)} | ${pad(String(r.totalTrades), 7)} | ${pad(String(r.winRate) + "%", 6)} | ${pad((pnl >= 0 ? "+" : "") + pnl.toFixed(2), 10)} | $${r.maxDrawdown}`
    );
  });
  console.log();
}

async function stopRun(runId: string) {
  if (!runId) {
    console.error("Usage: cli stop <runId>");
    return;
  }
  const res = await apiFetch(`/api/runs/${runId}`, "PATCH", {
    status: "stopped",
    stoppedAt: Math.floor(Date.now() / 1000),
    stopReason: "user",
  });
  if (res.ok) {
    console.log(`Run ${runId} stopped.`);
  } else {
    console.error("Failed to stop run.");
  }
}

// ─── Events Commands ───

async function listEvents(runId: string) {
  if (!runId) {
    console.error("Usage: cli events <runId> [--type <eventType>]");
    return;
  }

  const typeIdx = args.indexOf("--type");
  const type = typeIdx >= 0 ? args[typeIdx + 1] : undefined;
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? args[limitIdx + 1] : "100";

  const params = new URLSearchParams({ runId, limit: limit! });
  if (type) params.set("type", type);

  const res = await apiFetch(`/api/events?${params}`, "GET");
  if (!res.ok) {
    console.error("Failed to fetch events.");
    return;
  }

  const rows = await res.json() as Record<string, unknown>[];
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log("No events found.");
    return;
  }

  console.log(
    `\n  ${pad("Time", 20)} | ${pad("Type", 20)} | Payload`
  );
  console.log("  " + "-".repeat(80));
  // Reverse to show oldest first
  for (const e of [...rows].reverse()) {
    const time = fmtTime(e.timestamp as number);
    const payload = JSON.stringify(e.payload ?? {});
    const truncPayload = payload.length > 60 ? payload.slice(0, 57) + "..." : payload;
    console.log(
      `  ${pad(time, 20)} | ${pad(String(e.type), 20)} | ${truncPayload}`
    );
  }
  console.log(`\n  Total: ${rows.length} events\n`);
}

async function replayEvents(runId: string) {
  if (!runId) {
    console.error("Usage: cli replay <runId>");
    return;
  }

  const res = await apiFetch(`/api/events?runId=${encodeURIComponent(runId)}&limit=1000`, "GET");
  if (!res.ok) {
    console.error("Failed to fetch events.");
    return;
  }

  const rows = await res.json() as Record<string, unknown>[];
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log("No events found.");
    return;
  }

  // Sort oldest first
  const sorted = [...rows].sort((a, b) => (a.timestamp as number) - (b.timestamp as number));
  const startTs = sorted[0]!.timestamp as number;

  console.log(`\n  ${colors.bold("REPLAY")} — Run: ${runId}`);
  console.log(`  Start: ${fmtTime(startTs)}`);
  console.log("  " + "-".repeat(80));

  for (const e of sorted) {
    const elapsed = (e.timestamp as number) - startTs;
    const elapsedStr = `+${fmtDuration(elapsed)}`;
    const type = String(e.type);
    const colorFn = colorForEventType(type);
    const payload = JSON.stringify(e.payload ?? {});
    const truncPayload = payload.length > 60 ? payload.slice(0, 57) + "..." : payload;

    console.log(
      `  ${colors.gray(pad(elapsedStr, 8))} ${colorFn(pad(type, 20))} ${truncPayload}`
    );
  }
  console.log(`\n  ${sorted.length} events over ${fmtDuration((sorted[sorted.length - 1]!.timestamp as number) - startTs)}\n`);
}

// ─── Agent Management Commands ───

async function agentsList() {
  const res = await apiFetch("/api/agents", "GET");
  if (!res.ok) {
    console.error("Failed to fetch agents.");
    return;
  }

  const rows = await res.json() as Record<string, unknown>[];
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log("No agents registered.");
    return;
  }

  console.log(
    `\n  ${pad("Name", 20)} | ${pad("Path", 40)} | Description`
  );
  console.log("  " + "-".repeat(85));
  for (const a of rows) {
    console.log(
      `  ${pad(String(a.name), 20)} | ${pad(String(a.path), 40)} | ${a.description || "-"}`
    );
  }
  console.log(`\n  Total: ${rows.length} agents\n`);
}

async function agentsAdd() {
  let name = "";
  let path = "";
  let description = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) { name = args[++i]!; continue; }
    if (args[i] === "--path" && args[i + 1]) { path = args[++i]!; continue; }
    if (args[i] === "--description" && args[i + 1]) { description = args[++i]!; continue; }
  }

  if (!name || !path) {
    console.error("Usage: cli agents add --name <name> --path <./path/to/agent.ts> [--description '...']");
    return;
  }

  // Resolve to absolute path
  const absolutePath = path.startsWith("/") ? path : `${process.cwd()}/${path}`;

  const res = await apiFetch("/api/agents", "POST", {
    name,
    path: absolutePath,
    description: description || null,
  });

  if (res.ok) {
    console.log(`Agent "${name}" registered at ${absolutePath}`);
  } else {
    const err = await res.json() as Record<string, unknown>;
    console.error("Failed to register agent:", err);
  }
}

async function agentsRemove(name: string) {
  if (!name) {
    console.error("Usage: cli agents remove <name>");
    return;
  }
  const res = await apiFetch(`/api/agents/${encodeURIComponent(name)}`, "DELETE");
  if (res.ok) {
    console.log(`Agent "${name}" removed.`);
  } else {
    console.error("Failed to remove agent.");
  }
}

async function agentsRun(name: string) {
  if (!name) {
    console.error("Usage: cli agents run <name> [--active <id>] [--balance <amount>] [--config key=value ...]");
    return;
  }

  // Parse CLI flags
  let activeId = 76;
  let balance = 100;
  const configOverrides: Record<string, unknown> = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--active" && args[i + 1]) { activeId = Number(args[++i]); continue; }
    if (args[i] === "--balance" && args[i + 1]) { balance = Number(args[++i]); continue; }
    if (args[i] === "--config" && args[i + 1]) {
      // Parse key=value pairs
      while (args[i + 1] && !args[i + 1]!.startsWith("--")) {
        const kv = args[++i]!;
        const eqIdx = kv.indexOf("=");
        if (eqIdx > 0) {
          const key = kv.slice(0, eqIdx);
          const val = kv.slice(eqIdx + 1);
          configOverrides[key] = isNaN(Number(val)) ? val : Number(val);
        }
      }
      continue;
    }
  }

  // 1. Fetch agent registration
  const agentRes = await apiFetch(`/api/agents/${encodeURIComponent(name)}`, "GET");
  if (!agentRes.ok) {
    console.error(`Agent "${name}" not found. Register it first with: cli agents add --name ${name} --path <path>`);
    return;
  }
  const agentInfo = await agentRes.json() as { name: string; path: string; defaultConfig?: Record<string, unknown> };

  // 2. Dynamic import
  let mod: Record<string, unknown>;
  try {
    mod = await import(agentInfo.path);
  } catch (err) {
    console.error(`Failed to import agent from ${agentInfo.path}: ${(err as Error).message}`);
    return;
  }

  const createAgent = mod.createAgent as ((config: Record<string, unknown>) => import("../env/types.ts").Agent) | undefined;
  if (typeof createAgent !== "function") {
    console.error(`Agent file must export: createAgent(config: Record<string, unknown>): Agent`);
    return;
  }

  // 3. Merge config
  const mergedConfig: Record<string, unknown> = {
    ...(agentInfo.defaultConfig ?? {}),
    activeId,
    ...configOverrides,
  };

  const agent = createAgent(mergedConfig);
  console.log(`=== Dynamic Agent: ${agent.name} ===\n`);

  // 4. Create Runner
  const { AgentRunner } = await import("../bot/infra/runner.ts");

  const runner = new AgentRunner({
    credentials: {
      email: process.env.IQ_EMAIL!,
      password: process.env.IQ_PASSWORD!,
    },
    ssid: process.env.IQ_SSID,
    agent,
    agentId: name,
    agentType: name,
    agentConfig: mergedConfig,
    wallet: {
      mode: (process.env.WALLET_MODE as "virtual" | "real") || "virtual",
      initialBalance: balance,
    },
  });

  console.log(`Asset ID: ${activeId} | Run ID: ${runner.getRunId()}`);
  await runner.start();
}

// ─── Agent subcommand dispatcher ───

async function agentsCommand() {
  const sub = args[0];
  const subArgs = args.slice(1);

  switch (sub) {
    case "list":
      return agentsList();
    case "add":
      // args already has the flags after "agents"
      return agentsAdd();
    case "remove":
      return agentsRemove(subArgs[0]!);
    case "run":
      return agentsRun(subArgs[0]!);
    default:
      console.log("Usage: cli agents <list|add|remove|run> [args]");
      console.log("\n  list                              List registered agents");
      console.log("  add --name <n> --path <p> [--description '...']  Register an agent");
      console.log("  remove <name>                     Unregister an agent");
      console.log("  run <name> [--active 76] [--balance 100] [--config k=v ...]  Run an agent");
  }
}

// ─── Dataset Commands ───

async function datasetCreate() {
  let name = "";
  let activeId = 0;
  let candleSize = 0;
  let fromDate = "";
  let toDate = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) { name = args[++i]!; continue; }
    if (args[i] === "--active" && args[i + 1]) { activeId = Number(args[++i]); continue; }
    if (args[i] === "--candle-size" && args[i + 1]) { candleSize = Number(args[++i]); continue; }
    if (args[i] === "--from" && args[i + 1]) { fromDate = args[++i]!; continue; }
    if (args[i] === "--to" && args[i + 1]) { toDate = args[++i]!; continue; }
  }

  if (!name || !activeId || !candleSize || !fromDate || !toDate) {
    console.error("Usage: cli dataset create --name <n> --active <id> --candle-size <s> --from <date> --to <date>");
    return;
  }

  const fromTs = Math.floor(new Date(fromDate).getTime() / 1000);
  const toTs = Math.floor(new Date(toDate).getTime() / 1000);

  if (isNaN(fromTs) || isNaN(toTs)) {
    console.error("Invalid date format. Use YYYY-MM-DD.");
    return;
  }

  console.log(`\n  Creating dataset "${name}": active=${activeId}, size=${candleSize}s, ${fromDate} → ${toDate}`);

  // Connect to IQ Option to fetch candles + asset config
  const { IQWebSocket } = await import("../client/ws.ts");
  const { Protocol } = await import("../client/protocol.ts");
  const { login, authenticateWs } = await import("../client/auth.ts");
  const { CandlesAPI } = await import("../api/candles.ts");
  const { AssetsAPI } = await import("../api/assets.ts");

  let ssid = process.env.IQ_SSID || "";
  if (!ssid) {
    const email = process.env.IQ_EMAIL!;
    const password = process.env.IQ_PASSWORD!;
    if (!email || !password) {
      console.error("Set IQ_SSID or IQ_EMAIL+IQ_PASSWORD environment variables.");
      return;
    }
    console.log("  Logging in...");
    const result = await login(email, password);
    ssid = result.ssid;
  }

  const ws = new IQWebSocket();
  await ws.connect();
  const protocol = new Protocol(ws);
  await authenticateWs(protocol, ssid);
  console.log("  Connected to IQ Option.");

  // Fetch asset config
  const assetsApi = new AssetsAPI(protocol);
  let assetConfig: Record<string, unknown> | null = null;
  try {
    const initData = await assetsApi.getInitializationData();
    const configs = assetsApi.parseBlitzOptions(initData);
    const match = configs.find((c: { active_id?: number }) => c.active_id === activeId);
    if (match) assetConfig = match as unknown as Record<string, unknown>;
  } catch {
    console.warn("  Could not fetch asset config (will use defaults).");
  }

  // Fetch candles in chunks (IQ API limits per request)
  const candlesApi = new CandlesAPI(protocol, ws);
  const allCandles: Record<string, unknown>[] = [];
  const chunkSize = 1000 * candleSize; // 1000 candles per chunk

  let cursor = fromTs;
  while (cursor < toTs) {
    const chunkEnd = Math.min(cursor + chunkSize, toTs);
    process.stdout.write(`\r  Fetching candles... ${new Date(cursor * 1000).toISOString().slice(0, 10)} → ${new Date(chunkEnd * 1000).toISOString().slice(0, 10)}`);

    try {
      const candles = await candlesApi.getCandles(activeId, candleSize, cursor, chunkEnd);
      for (const c of candles) {
        allCandles.push(c as unknown as Record<string, unknown>);
      }
    } catch (err) {
      console.error(`\n  Fetch error at ${cursor}: ${(err as Error).message}`);
    }

    cursor = chunkEnd;
    // Small delay to avoid rate limiting
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\n  Fetched ${allCandles.length} candles.`);

  if (allCandles.length === 0) {
    console.error("  No candles fetched. Check active ID and date range.");
    ws.close();
    return;
  }

  // Store in SQLite
  const { db } = await import("../server/db/index.ts");
  const { datasets, datasetCandles } = await import("../server/db/schema.ts");

  // Delete existing dataset with same name (if any)
  const { eq } = await import("drizzle-orm");
  await db.delete(datasetCandles).where(eq(datasetCandles.dataset, name));
  await db.delete(datasets).where(eq(datasets.name, name));

  // Insert dataset metadata
  await db.insert(datasets).values({
    name,
    activeId,
    candleSize,
    fromTs,
    toTs,
    candleCount: allCandles.length,
    assetConfig,
    createdAt: Math.floor(Date.now() / 1000),
  });

  // Insert candles in batches
  const batchSize = 500;
  for (let i = 0; i < allCandles.length; i += batchSize) {
    const batch = allCandles.slice(i, i + batchSize);
    await db.insert(datasetCandles).values(
      batch.map((c: any) => ({
        dataset: name,
        from: c.from,
        to: c.to,
        open: c.open,
        close: c.close,
        min: c.min,
        max: c.max,
        volume: c.volume ?? 0,
        activeId: c.active_id ?? activeId,
        size: c.size ?? candleSize,
      })),
    );
  }

  console.log(`  Dataset "${name}" stored: ${allCandles.length} candles.`);

  ws.close();
  process.exit(0);
}

async function datasetList() {
  const { db } = await import("../server/db/index.ts");
  const { datasets } = await import("../server/db/schema.ts");

  const rows = await db.select().from(datasets);
  if (rows.length === 0) {
    console.log("No datasets found.");
    return;
  }

  console.log(
    `\n  ${pad("Name", 20)} | ${pad("Asset", 6)} | ${pad("Size", 5)} | ${pad("From", 12)} | ${pad("To", 12)} | Candles`,
  );
  console.log("  " + "-".repeat(80));
  for (const d of rows) {
    const from = new Date(d.fromTs * 1000).toISOString().slice(0, 10);
    const to = new Date(d.toTs * 1000).toISOString().slice(0, 10);
    console.log(
      `  ${pad(d.name, 20)} | ${pad(String(d.activeId), 6)} | ${pad(d.candleSize + "s", 5)} | ${pad(from, 12)} | ${pad(to, 12)} | ${d.candleCount}`,
    );
  }
  console.log(`\n  Total: ${rows.length} datasets\n`);
}

async function datasetDelete(name: string) {
  if (!name) {
    console.error("Usage: cli dataset delete <name>");
    return;
  }

  const { db } = await import("../server/db/index.ts");
  const { datasets, datasetCandles } = await import("../server/db/schema.ts");
  const { eq } = await import("drizzle-orm");

  await db.delete(datasetCandles).where(eq(datasetCandles.dataset, name));
  const result = await db.delete(datasets).where(eq(datasets.name, name));
  console.log(`Dataset "${name}" deleted.`);
}

async function datasetCommand() {
  const sub = args[0];
  const subArgs = args.slice(1);

  switch (sub) {
    case "create":
      return datasetCreate();
    case "list":
      return datasetList();
    case "delete":
      return datasetDelete(subArgs[0]!);
    default:
      console.log("Usage: cli dataset <create|list|delete> [args]");
      console.log("\n  create --name <n> --active <id> --candle-size <s> --from <date> --to <date>");
      console.log("  list                              List all datasets");
      console.log("  delete <name>                     Delete a dataset");
  }
}

// ─── Backtest Command ───

async function backtestRun(agentName: string) {
  if (!agentName) {
    console.error("Usage: cli backtest <agentName> --dataset <name>[,name2] --balance <n> [--payout <n>] [--config key=value ...]");
    return;
  }

  let datasetStr = "";
  let balance = 100;
  let payout: number | undefined;
  const configOverrides: Record<string, unknown> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dataset" && args[i + 1]) { datasetStr = args[++i]!; continue; }
    if (args[i] === "--balance" && args[i + 1]) { balance = Number(args[++i]); continue; }
    if (args[i] === "--payout" && args[i + 1]) { payout = Number(args[++i]); continue; }
    if (args[i] === "--config" && args[i + 1]) {
      while (args[i + 1] && !args[i + 1]!.startsWith("--")) {
        const kv = args[++i]!;
        const eqIdx = kv.indexOf("=");
        if (eqIdx > 0) {
          const key = kv.slice(0, eqIdx);
          const val = kv.slice(eqIdx + 1);
          configOverrides[key] = isNaN(Number(val)) ? val : Number(val);
        }
      }
      continue;
    }
  }

  if (!datasetStr) {
    console.error("--dataset is required. Example: --dataset eurusd-feb");
    return;
  }

  const datasetNames = datasetStr.split(",").map((s) => s.trim());

  // 1. Fetch agent registration
  const agentRes = await apiFetch(`/api/agents/${encodeURIComponent(agentName)}`, "GET");
  if (!agentRes.ok) {
    console.error(`Agent "${agentName}" not found. Register it first with: cli agents add --name ${agentName} --path <path>`);
    return;
  }
  const agentInfo = await agentRes.json() as { name: string; path: string; defaultConfig?: Record<string, unknown> };

  // 2. Dynamic import agent
  let mod: Record<string, unknown>;
  try {
    mod = await import(agentInfo.path);
  } catch (err) {
    console.error(`Failed to import agent from ${agentInfo.path}: ${(err as Error).message}`);
    return;
  }

  const createAgent = mod.createAgent as ((config: Record<string, unknown>) => import("../env/types.ts").Agent) | undefined;
  if (typeof createAgent !== "function") {
    console.error(`Agent file must export: createAgent(config: Record<string, unknown>): Agent`);
    return;
  }

  // 3. Get dataset metadata to extract activeId + candleSize
  const { db: btDb } = await import("../server/db/index.ts");
  const { datasets: dsTable } = await import("../server/db/schema.ts");
  const { eq: eqOp } = await import("drizzle-orm");

  const firstDs = await btDb.query.datasets.findFirst({
    where: eqOp(dsTable.name, datasetNames[0]!),
  });
  if (!firstDs) {
    console.error(`Dataset "${datasetNames[0]}" not found.`);
    return;
  }

  // 3b. Merge config: defaults + dataset-derived values + overrides
  const mergedConfig: Record<string, unknown> = {
    ...(agentInfo.defaultConfig ?? {}),
    activeId: firstDs.activeId,
    candleSize: firstDs.candleSize,
    ...configOverrides,
  };

  const agent = createAgent(mergedConfig);

  console.log(`\n  ${colors.bold("BACKTEST")} — ${agent.name}`);
  console.log(`  Datasets: ${datasetNames.join(", ")}`);
  console.log(`  Balance: $${balance}${payout ? ` | Payout: ${payout}%` : ""}`);
  console.log("  " + "-".repeat(60));

  // 4. Run backtest
  const { BacktestRunner } = await import("../backtest/runner.ts");

  const runner = new BacktestRunner({
    agentName,
    agentConfig: mergedConfig,
    datasetNames,
    initialBalance: balance,
    payoutPercent: payout,
  });

  const startMs = performance.now();
  const result = await runner.run(agent);
  const elapsedMs = performance.now() - startMs;

  // 5. Print results
  const pnlColor = result.pnl >= 0 ? colors.green : colors.red;
  const wrColor = result.winRate >= 55 ? colors.green : result.winRate >= 50 ? colors.yellow : colors.red;

  console.log(`\n  ${colors.bold("RESULTS")}`);
  console.log("  " + "-".repeat(40));
  console.log(`  Trades:       ${result.trades} (${result.wins}W / ${result.losses}L)`);
  console.log(`  Win Rate:     ${wrColor(result.winRate + "%")}`);
  console.log(`  PnL:          ${pnlColor((result.pnl >= 0 ? "+" : "") + "$" + result.pnl.toFixed(2))}`);
  console.log(`  Max Drawdown: ${colors.red("$" + result.maxDrawdown.toFixed(2))}`);
  console.log(`  Final Balance:$${result.finalBalance.toFixed(2)}`);
  console.log(`  Candles:      ${result.durationCandles}`);
  console.log(`  Duration:     ${(elapsedMs / 1000).toFixed(2)}s`);
  console.log(`  Run ID:       ${colors.cyan(result.runId)}`);
  console.log();
}

// ─── Command Router ───

const commands: Record<string, () => Promise<void>> = {
  list: () => list(),
  stats: () => stats(args[0]!),
  compare: () => compare(...args),
  trades: () => listTrades(args[0]!),
  leaderboard: () => leaderboard(),
  stop: () => stopRun(args[0]!),
  events: () => listEvents(args[0]!),
  replay: () => replayEvents(args[0]!),
  agents: () => agentsCommand(),
  dataset: () => datasetCommand(),
  backtest: () => backtestRun(args[0]!),
};

async function main() {
  if (!command || !commands[command]) {
    console.log("Usage: bun run src/cli/cli.ts <command> [args]");
    console.log("\nCommands:");
    console.log("  list [running|stopped]     List all runs");
    console.log("  stats <runId>              Show run stats");
    console.log("  compare <id1> <id2> ...    Compare runs side-by-side");
    console.log("  trades <runId>             List trades for a run");
    console.log("  leaderboard [pnl|winRate]  Best runs ranked");
    console.log("  stop <runId>               Signal a run to stop");
    console.log("  events <runId> [--type <t>] [--limit <n>]  List events for a run");
    console.log("  replay <runId>             Timeline replay of events");
    console.log("  agents <list|add|remove|run>  Manage agents");
    console.log("  dataset <create|list|delete>  Manage datasets");
    console.log("  backtest <agent> --dataset <name> --balance <n>  Run backtest");
    return;
  }

  await commands[command]!();
}

main().catch((err) => {
  console.error("Error:", err.message ?? err);
  process.exit(1);
});
