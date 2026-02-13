import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import * as schema from "./schema.ts";

const sqlite = new Database("data/trading.db");
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA busy_timeout = 5000;");    // wait up to 5s on lock instead of failing immediately
sqlite.exec("PRAGMA synchronous = NORMAL;");   // safe with WAL, reduces fsync overhead
sqlite.exec("CREATE INDEX IF NOT EXISTS idx_events_run_type ON events(run_id, type);");
sqlite.exec("CREATE INDEX IF NOT EXISTS idx_events_run_ts ON events(run_id, timestamp);");
sqlite.exec("CREATE INDEX IF NOT EXISTS idx_dataset_candles ON dataset_candles(dataset, \"from\");");
export const db = drizzle({ client: sqlite, schema });
