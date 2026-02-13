import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const runs = sqliteTable("runs", {
  id:           text("id").primaryKey(),
  agentType:    text("agent_type").notNull(),
  agentId:      text("agent_id").notNull(),
  config:       text("config", { mode: "json" }).$type<Record<string, unknown>>(),
  walletMode:   text("wallet_mode", { enum: ["virtual", "real"] }).default("virtual"),
  startBalance: real("start_balance").notNull(),
  startedAt:    integer("started_at").notNull(),
  stoppedAt:    integer("stopped_at"),
  stopReason:   text("stop_reason"),
  status:       text("status", { enum: ["running", "stopped"] }).default("running"),
});

export const trades = sqliteTable("trades", {
  id:          integer("id").primaryKey({ autoIncrement: true }),
  runId:       text("run_id").notNull().references(() => runs.id),
  placedAt:    integer("placed_at").notNull(),
  direction:   text("direction", { enum: ["call", "put"] }).notNull(),
  amount:      real("amount").notNull(),
  activeId:    integer("active_id").notNull(),
  expiration:  integer("expiration").notNull(),
  entryPrice:  real("entry_price"),
  exitPrice:   real("exit_price"),
  result:      text("result", { enum: ["win", "loss"] }),
  pnl:         real("pnl"),
  closedAt:    integer("closed_at"),
  walletAfter: real("wallet_after"),
});

export const events = sqliteTable("events", {
  id:        integer("id").primaryKey({ autoIncrement: true }),
  runId:     text("run_id").notNull().references(() => runs.id),
  type:      text("type").notNull(),
  timestamp: integer("timestamp").notNull(),
  payload:   text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
});

export const agents = sqliteTable("agents", {
  name:          text("name").primaryKey(),
  path:          text("path").notNull(),
  description:   text("description"),
  defaultConfig: text("default_config", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt:     integer("created_at").notNull(),
});

export const datasets = sqliteTable("datasets", {
  name:        text("name").primaryKey(),
  activeId:    integer("active_id").notNull(),
  candleSize:  integer("candle_size").notNull(),
  fromTs:      integer("from_ts").notNull(),
  toTs:        integer("to_ts").notNull(),
  candleCount: integer("candle_count").notNull(),
  assetConfig: text("asset_config", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt:   integer("created_at").notNull(),
});

export const datasetCandles = sqliteTable("dataset_candles", {
  id:        integer("id").primaryKey({ autoIncrement: true }),
  dataset:   text("dataset").notNull().references(() => datasets.name),
  from:      integer("from").notNull(),
  to:        integer("to").notNull(),
  open:      real("open").notNull(),
  close:     real("close").notNull(),
  min:       real("min").notNull(),
  max:       real("max").notNull(),
  volume:    real("volume").notNull(),
  activeId:  integer("active_id").notNull(),
  size:      integer("size").notNull(),
});

export const snapshots = sqliteTable("snapshots", {
  id:       integer("id").primaryKey({ autoIncrement: true }),
  runId:    text("run_id").notNull().references(() => runs.id),
  ts:       integer("ts").notNull(),
  wallet:   real("wallet").notNull(),
  wins:     integer("wins").notNull(),
  losses:   integer("losses").notNull(),
  totalPnl: real("total_pnl").notNull(),
  drawdown: real("drawdown").notNull(),
});
