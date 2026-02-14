import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { api, apiFetch } from "./api.ts";

// ─── Helpers ───

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

// ─── Config coercion ───

function parseConfigValue(val: string): unknown {
  if (val === "true") return true;
  if (val === "false") return false;
  if (val === "null") return null;
  if (val !== "" && !isNaN(Number(val))) return Number(val);
  if ((val.startsWith("{") && val.endsWith("}")) || (val.startsWith("[") && val.endsWith("]"))) {
    try { return JSON.parse(val); } catch { return val; }
  }
  return val;
}

function coerceConfig(arr: string[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const kv of arr) {
    const eq = kv.indexOf("=");
    if (eq > 0) obj[kv.slice(0, eq)] = parseConfigValue(kv.slice(eq + 1));
  }
  return obj;
}

// ─── Shared: resolve auth profile ───

async function resolveProfile(explicitProfile?: string): Promise<string | null> {
  if (explicitProfile) return explicitProfile;
  try {
    const res = await apiFetch("/api/auth/profiles", "GET");
    if (res.ok) {
      const profiles = await res.json() as { name: string; isDefault: boolean }[];
      const def = profiles.find((p) => p.isDefault);
      if (def) return def.name;
    }
  } catch {
    // Server not running — fall through to .env
  }
  return null;
}

// ─── Command handlers ───

async function list(status?: string) {
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

async function compare(ids: string[]) {
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

async function leaderboard(sort: string) {
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

async function listEvents(runId: string, type?: string, limit: number = 100) {
  const params = new URLSearchParams({ runId, limit: String(limit) });
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

// ─── Auth handlers ───

async function authList() {
  const res = await apiFetch("/api/auth/profiles", "GET");
  if (!res.ok) {
    console.error("Failed to fetch profiles. Is the server running?");
    return;
  }

  const rows = await res.json() as { name: string; email: string; isDefault: boolean; createdAt: number; lastUsedAt: number | null }[];
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log("No auth profiles found.");
    return;
  }

  console.log(
    `\n  ${pad("Name", 20)} | ${pad("Email", 30)} | ${pad("Default", 8)} | Last Used`
  );
  console.log("  " + "-".repeat(85));
  for (const p of rows) {
    const lastUsed = p.lastUsedAt ? fmtTime(p.lastUsedAt) : "never";
    const def = p.isDefault ? colors.green("yes") : "no";
    console.log(
      `  ${pad(p.name, 20)} | ${pad(p.email, 30)} | ${pad(def, 8)} | ${lastUsed}`
    );
  }
  console.log(`\n  Total: ${rows.length} profiles\n`);
}

async function authAdd(profile: string, email: string, password: string, isDefault: boolean) {
  const res = await apiFetch("/api/auth/profiles", "POST", {
    name: profile,
    email,
    password,
    isDefault,
  });

  if (res.ok) {
    console.log(`Profile "${profile}" added.${isDefault ? " (set as default)" : ""}`);
  } else {
    const err = await res.json() as Record<string, unknown>;
    console.error("Failed to add profile:", err);
  }
}

async function authRemove(name: string) {
  const res = await apiFetch(`/api/auth/profiles/${encodeURIComponent(name)}`, "DELETE");
  if (res.ok) {
    console.log(`Profile "${name}" removed.`);
  } else {
    console.error("Failed to remove profile.");
  }
}

async function authDefault(name: string) {
  const res = await apiFetch(`/api/auth/profiles/${encodeURIComponent(name)}/default`, "PATCH");
  if (res.ok) {
    console.log(`Profile "${name}" set as default.`);
  } else {
    const err = await res.json() as Record<string, unknown>;
    console.error("Failed to set default:", err);
  }
}

// ─── Agent handlers ───

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

async function agentsAdd(name: string, path: string, description?: string) {
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
  const res = await apiFetch(`/api/agents/${encodeURIComponent(name)}`, "DELETE");
  if (res.ok) {
    console.log(`Agent "${name}" removed.`);
  } else {
    console.error("Failed to remove agent.");
  }
}

async function agentsRun(
  name: string,
  activeId: number,
  balance: number,
  durationSeconds: number | undefined,
  explicitProfile: string | undefined,
  realMode: boolean,
  configOverrides: Record<string, unknown>,
) {
  // Safety rail for real mode
  if (realMode) {
    const profileLabel = explicitProfile ?? "default";
    console.log(`\n  ${colors.red(colors.bold("⚠ WARNING: REAL MONEY MODE ⚠"))}`);
    console.log(`  Agent: ${name} | Profile: ${profileLabel}`);
    process.stdout.write('  Type "CONFIRM" to proceed: ');

    const reader = (await import("readline")).createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const confirmed = await new Promise<boolean>((resolve) => {
      reader.on("line", (line: string) => {
        reader.close();
        resolve(line.trim() === "CONFIRM");
      });
    });

    if (!confirmed) {
      console.log("  Aborted.");
      process.exit(0);
    }
    console.log();
  }

  const accountMode: "demo" | "real" = realMode ? "real" : "demo";

  const profileName = await resolveProfile(explicitProfile);

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
  console.log(`=== Dynamic Agent: ${agent.name} ===`);
  console.log(`  Mode: ${accountMode}${profileName ? ` | Profile: ${profileName}` : " | Auth: .env fallback"}\n`);

  // 4. Create Runner
  const { AgentRunner } = await import("../bot/infra/runner.ts");

  const runnerCfg: import("../bot/infra/runner.ts").RunnerConfig = {
    agent,
    agentId: name,
    agentType: name,
    agentConfig: mergedConfig,
    accountMode,
    wallet: {
      mode: (process.env.WALLET_MODE as "virtual" | "real") || "virtual",
      initialBalance: balance,
    },
    maxDuration: durationSeconds,
  };

  if (profileName) {
    runnerCfg.profile = profileName;
  } else {
    runnerCfg.credentials = {
      email: process.env.IQ_EMAIL!,
      password: process.env.IQ_PASSWORD!,
    };
    runnerCfg.ssid = process.env.IQ_SSID;
  }

  const runner = new AgentRunner(runnerCfg);

  console.log(`Asset ID: ${activeId} | Run ID: ${runner.getRunId()}`);
  await runner.start();
}

// ─── Dataset handlers ───

async function datasetCreate(
  name: string,
  activeId: number,
  candleSize: number,
  fromDate: string,
  toDate: string,
  explicitProfile?: string,
) {
  const fromTs = Math.floor(new Date(fromDate).getTime() / 1000);
  const toTs = Math.floor(new Date(toDate).getTime() / 1000);

  if (isNaN(fromTs) || isNaN(toTs)) {
    console.error("Invalid date format. Use YYYY-MM-DD.");
    return;
  }

  console.log(`\n  Creating dataset "${name}": active=${activeId}, size=${candleSize}s, ${fromDate} → ${toDate}`);

  const { IQWebSocket } = await import("../client/ws.ts");
  const { Protocol } = await import("../client/protocol.ts");
  const { login, authenticateWs } = await import("../client/auth.ts");
  const { CandlesAPI } = await import("../api/candles.ts");
  const { AssetsAPI } = await import("../api/assets.ts");

  let ssid = "";
  const profileName = await resolveProfile(explicitProfile);
  if (profileName) {
    try {
      const profileRes = await apiFetch(`/api/auth/profiles/${encodeURIComponent(profileName)}/ssid`, "POST");
      if (profileRes.ok) {
        const data = await profileRes.json() as { ssid: string };
        ssid = data.ssid;
        console.log(`  Auth via profile "${profileName}"`);
      }
    } catch {
      // Fall through to .env
    }
  }

  if (!ssid) {
    ssid = process.env.IQ_SSID || "";
    if (!ssid) {
      const email = process.env.IQ_EMAIL!;
      const password = process.env.IQ_PASSWORD!;
      if (!email || !password) {
        console.error("No auth available. Add a profile or set IQ_EMAIL+IQ_PASSWORD env vars.");
        return;
      }
      console.log("  Logging in...");
      const result = await login(email, password);
      ssid = result.ssid;
    }
  }

  const ws = new IQWebSocket();
  await ws.connect();
  const protocol = new Protocol(ws);
  await authenticateWs(protocol, ssid);
  console.log("  Connected to IQ Option.");

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

  const candlesApi = new CandlesAPI(protocol, ws);
  const allCandles: Record<string, unknown>[] = [];
  const chunkSize = 1000 * candleSize;

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
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\n  Fetched ${allCandles.length} candles.`);

  if (allCandles.length === 0) {
    console.error("  No candles fetched. Check active ID and date range.");
    ws.close();
    return;
  }

  const { db } = await import("../server/db/index.ts");
  const { datasets, datasetCandles } = await import("../server/db/schema.ts");

  const { eq } = await import("drizzle-orm");
  await db.delete(datasetCandles).where(eq(datasetCandles.dataset, name));
  await db.delete(datasets).where(eq(datasets.name, name));

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
  const { db } = await import("../server/db/index.ts");
  const { datasets, datasetCandles } = await import("../server/db/schema.ts");
  const { eq } = await import("drizzle-orm");

  await db.delete(datasetCandles).where(eq(datasetCandles.dataset, name));
  await db.delete(datasets).where(eq(datasets.name, name));
  console.log(`Dataset "${name}" deleted.`);
}

// ─── Assets handler ───

async function assetsList(explicitProfile?: string, showAll = false) {
  const { IQWebSocket } = await import("../client/ws.ts");
  const { Protocol } = await import("../client/protocol.ts");
  const { login, authenticateWs } = await import("../client/auth.ts");
  const { AssetsAPI } = await import("../api/assets.ts");

  // Auth resolution: profile > .env
  let ssid = "";
  const profileName = await resolveProfile(explicitProfile);
  if (profileName) {
    try {
      const profileRes = await apiFetch(`/api/auth/profiles/${encodeURIComponent(profileName)}/ssid`, "POST");
      if (profileRes.ok) {
        const data = await profileRes.json() as { ssid: string };
        ssid = data.ssid;
      }
    } catch {
      // Fall through to .env
    }
  }

  if (!ssid) {
    ssid = process.env.IQ_SSID || "";
    if (!ssid) {
      const email = process.env.IQ_EMAIL!;
      const password = process.env.IQ_PASSWORD!;
      if (!email || !password) {
        console.error("No auth available. Add a profile or set IQ_EMAIL+IQ_PASSWORD env vars.");
        return;
      }
      console.log("  Logging in...");
      const result = await login(email, password);
      ssid = result.ssid;
    }
  }

  const ws = new IQWebSocket();
  await ws.connect();
  const protocol = new Protocol(ws);
  await authenticateWs(protocol, ssid);

  const assetsApi = new AssetsAPI(protocol);
  const initData = await assetsApi.getInitializationData();
  const allConfigs = assetsApi.parseBlitzOptions(initData);
  const configs = showAll ? allConfigs : allConfigs.filter((c) => c.is_enabled && !c.is_suspended);

  if (configs.length === 0) {
    console.log("No assets found.");
    ws.close();
    return;
  }

  console.log(
    `\n  ${pad("ID", 6)} | ${pad("Name", 20)} | ${pad("Payout", 8)} | ${pad("Min Bet", 8)} | ${pad("Max Bet", 10)} | ${pad("Deadtime", 9)} | ${pad("Expiries", 24)} | Status`,
  );
  console.log("  " + "-".repeat(110));

  for (const c of configs) {
    const payout = c.profit_commission > 0 ? `${(100 - c.profit_commission).toFixed(0)}%` : "-";
    const expiries = c.expiration_times.map((t) => (t >= 60 ? `${t / 60}m` : `${t}s`)).join(", ");
    const status = !c.is_enabled
      ? colors.red("disabled")
      : c.is_suspended
        ? colors.yellow("suspended")
        : colors.green("active");

    console.log(
      `  ${pad(String(c.active_id), 6)} | ${pad(c.name, 20)} | ${pad(payout, 8)} | $${pad(String(c.minimal_bet), 7)} | $${pad(String(c.maximal_bet), 9)} | ${pad(c.deadtime + "s", 9)} | ${pad(expiries, 24)} | ${status}`,
    );
  }

  console.log(`\n  Total: ${configs.length} assets${showAll ? "" : " (active only, use --all to include disabled/suspended)"}\n`);

  ws.close();
  process.exit(0);
}

// ─── Backtest handler ───

async function backtestRun(
  agentName: string,
  datasetStr: string,
  balance: number,
  payout: number | undefined,
  configOverrides: Record<string, unknown>,
) {
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

  // 3. Get dataset metadata
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

  // 3b. Merge config
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

// ─── Yargs CLI ───

const configOption = {
  type: "array" as const,
  string: true as const,
  describe: "Config overrides: key=value",
  coerce: coerceConfig,
};

yargs(hideBin(process.argv))
  .scriptName("cli")
  .command(
    "list [status]",
    "List all runs",
    (yargs) =>
      yargs.positional("status", {
        type: "string",
        choices: ["running", "stopped"] as const,
        describe: "Filter by status",
      }),
    async (argv) => {
      await list(argv.status);
    },
  )
  .command(
    "stats <runId>",
    "Show run stats",
    (yargs) =>
      yargs.positional("runId", { type: "string", demandOption: true }),
    async (argv) => {
      await stats(argv.runId!);
    },
  )
  .command(
    "compare <ids..>",
    "Compare runs side-by-side",
    (yargs) =>
      yargs.positional("ids", { type: "string", array: true, demandOption: true }),
    async (argv) => {
      await compare(argv.ids as string[]);
    },
  )
  .command(
    "trades <runId>",
    "List trades for a run",
    (yargs) =>
      yargs.positional("runId", { type: "string", demandOption: true }),
    async (argv) => {
      await listTrades(argv.runId!);
    },
  )
  .command(
    "leaderboard [sort]",
    "Best runs ranked",
    (yargs) =>
      yargs.positional("sort", {
        type: "string",
        default: "pnl",
        describe: "Sort by: pnl, winRate",
      }),
    async (argv) => {
      await leaderboard(argv.sort!);
    },
  )
  .command(
    "stop <runId>",
    "Signal a run to stop",
    (yargs) =>
      yargs.positional("runId", { type: "string", demandOption: true }),
    async (argv) => {
      await stopRun(argv.runId!);
    },
  )
  .command(
    "events <runId>",
    "List events for a run",
    (yargs) =>
      yargs
        .positional("runId", { type: "string", demandOption: true })
        .option("type", { type: "string", describe: "Filter by event type" })
        .option("limit", { type: "number", default: 100, describe: "Max events to fetch" }),
    async (argv) => {
      await listEvents(argv.runId!, argv.type, argv.limit);
    },
  )
  .command(
    "replay <runId>",
    "Timeline replay of events",
    (yargs) =>
      yargs.positional("runId", { type: "string", demandOption: true }),
    async (argv) => {
      await replayEvents(argv.runId!);
    },
  )
  .command(
    "auth",
    "Manage auth profiles",
    (yargs) =>
      yargs
        .command(
          "list",
          "Show profiles",
          () => {},
          async () => {
            await authList();
          },
        )
        .command(
          "add",
          "Add profile",
          (yargs) =>
            yargs
              .option("profile", { type: "string", demandOption: true, describe: "Profile name" })
              .option("email", { type: "string", demandOption: true, describe: "Email address" })
              .option("password", { type: "string", demandOption: true, describe: "Password" })
              .option("default", { type: "boolean", default: false, describe: "Set as default" }),
          async (argv) => {
            await authAdd(argv.profile, argv.email, argv.password, argv.default);
          },
        )
        .command(
          "remove <name>",
          "Remove profile",
          (yargs) =>
            yargs.positional("name", { type: "string", demandOption: true }),
          async (argv) => {
            await authRemove(argv.name!);
          },
        )
        .command(
          "default <name>",
          "Set default profile",
          (yargs) =>
            yargs.positional("name", { type: "string", demandOption: true }),
          async (argv) => {
            await authDefault(argv.name!);
          },
        )
        .demandCommand(1, "Please specify an auth subcommand."),
    () => {},
  )
  .command(
    "agents",
    "Manage agents",
    (yargs) =>
      yargs
        .command(
          "list",
          "List registered agents",
          () => {},
          async () => {
            await agentsList();
          },
        )
        .command(
          "add",
          "Register an agent",
          (yargs) =>
            yargs
              .option("name", { type: "string", demandOption: true, describe: "Agent name" })
              .option("path", { type: "string", demandOption: true, describe: "Path to agent file" })
              .option("description", { type: "string", describe: "Agent description" }),
          async (argv) => {
            await agentsAdd(argv.name, argv.path, argv.description);
          },
        )
        .command(
          "remove <name>",
          "Unregister an agent",
          (yargs) =>
            yargs.positional("name", { type: "string", demandOption: true }),
          async (argv) => {
            await agentsRemove(argv.name!);
          },
        )
        .command(
          "run <name>",
          "Run an agent",
          (yargs) =>
            yargs
              .positional("name", { type: "string", demandOption: true })
              .option("active", { type: "number", default: 76, describe: "Asset active ID" })
              .option("balance", { type: "number", default: 100, describe: "Initial balance" })
              .option("duration", { type: "number", describe: "Max duration in seconds" })
              .option("profile", { type: "string", describe: "Auth profile name" })
              .option("real", { type: "boolean", default: false, describe: "Use real money mode" })
              .option("config", configOption),
          async (argv) => {
            await agentsRun(
              argv.name!,
              argv.active,
              argv.balance,
              argv.duration,
              argv.profile,
              argv.real,
              (argv.config as Record<string, unknown>) ?? {},
            );
          },
        )
        .demandCommand(1, "Please specify an agents subcommand."),
    () => {},
  )
  .command(
    "dataset",
    "Manage datasets",
    (yargs) =>
      yargs
        .command(
          "create",
          "Create a dataset from IQ Option candles",
          (yargs) =>
            yargs
              .option("name", { type: "string", demandOption: true, describe: "Dataset name" })
              .option("active", { type: "number", demandOption: true, describe: "Asset active ID" })
              .option("candle-size", { type: "number", demandOption: true, describe: "Candle size in seconds" })
              .option("from", { type: "string", demandOption: true, describe: "Start date (YYYY-MM-DD)" })
              .option("to", { type: "string", demandOption: true, describe: "End date (YYYY-MM-DD)" })
              .option("profile", { type: "string", describe: "Auth profile name" }),
          async (argv) => {
            await datasetCreate(argv.name, argv.active, argv.candleSize, argv.from, argv.to, argv.profile);
          },
        )
        .command(
          "list",
          "List all datasets",
          () => {},
          async () => {
            await datasetList();
          },
        )
        .command(
          "delete <name>",
          "Delete a dataset",
          (yargs) =>
            yargs.positional("name", { type: "string", demandOption: true }),
          async (argv) => {
            await datasetDelete(argv.name!);
          },
        )
        .demandCommand(1, "Please specify a dataset subcommand."),
    () => {},
  )
  .command(
    "assets",
    "Browse available trading assets",
    (yargs) =>
      yargs
        .command(
          "list",
          "List available blitz-option assets",
          (yargs) =>
            yargs
              .option("profile", { type: "string", describe: "Auth profile name" })
              .option("all", { type: "boolean", default: false, describe: "Include disabled/suspended assets" }),
          async (argv) => {
            await assetsList(argv.profile, argv.all);
          },
        )
        .demandCommand(1, "Please specify an assets subcommand."),
    () => {},
  )
  .command(
    "backtest <agent>",
    "Run backtest",
    (yargs) =>
      yargs
        .positional("agent", { type: "string", demandOption: true, describe: "Agent name" })
        .option("dataset", { type: "string", demandOption: true, describe: "Dataset name(s), comma-separated" })
        .option("balance", { type: "number", default: 100, describe: "Initial balance" })
        .option("payout", { type: "number", describe: "Payout percentage" })
        .option("config", configOption),
    async (argv) => {
      await backtestRun(
        argv.agent!,
        argv.dataset,
        argv.balance,
        argv.payout,
        (argv.config as Record<string, unknown>) ?? {},
      );
    },
  )
  .demandCommand(1, "Please specify a command. Use --help to see available commands.")
  .help()
  .parseAsync()
  .catch((err: Error) => {
    console.error("Error:", err.message ?? err);
    process.exit(1);
  });
