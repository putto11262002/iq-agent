# Open Issues

## Auth Management (Server-Managed Sessions)

**Problem:** Credentials live in `.env`, each agent process does its own `login()`, SSID caching is per-process. No way to run multiple agents against different accounts.

**Proposed Solution:**
- `cli auth add --profile default --email x --password y` — store encrypted in SQLite (`auth_profiles` table)
- Server manages SSID lifecycle: login, cache, refresh when expired
- Runner requests valid SSID from server: `GET /api/auth/:profile/ssid`
- Multiple profiles supported: demo account, real account, different users
- No more `.env` credentials — centralized session management

**Scope:** Server DB + new `/api/auth` routes + CLI `auth` commands + Runner changes to fetch SSID from server

---

## Real vs Demo Account Mode

**Problem:** Only demo is supported. `environment.ts` hardcodes `account.getDemoBalance()`. The `walletMode: "virtual" | "real"` in RunnerConfig refers to the local tracking wallet, not the IQ Option account type.

**Proposed Solution:**
- Add `accountMode: "demo" | "real"` config at Environment level
- Fetch real or demo balance based on config
- Use correct balance ID for subscriptions and trade placement
- Ties into auth profiles — a profile specifies `demo` or `real`
- **Safety rails required:** explicit confirmation prompts, max loss limits, kill switch

**Scope:** Environment init changes + auth profile config + CLI safeguards

---

## Execution Safety Rails (Enforced In ActionExecutor)

**Problem:** Most safety controls live inside individual agents (and partially in Runner). The execution layer in `src/env/actions.ts` will currently place trades as long as the API call succeeds, so a buggy/misconfigured agent can:
- Spam orders (no global cooldown / rate limit)
- Exceed intended max concurrent positions
- Trade suspended/disabled assets
- Trade outside configured amount limits
- Trade while in the wrong account mode (demo/real) or without explicit opt-in

**Proposed Solution:** Add hard checks in the execution path (not just in agents):
- Central `preTradeCheck()` in `src/env/actions.ts` (or a dedicated risk module) applied to every `buyBlitzOption()` action
- Config-driven limits: `minAmount`, `maxAmount`, `maxOpenPositions`, `cooldownMs`, `maxTradesPerMinute`, `maxDailyLoss`, `killSwitch`
- Validate asset state/config (enabled, payout/expiration constraints) before sending RPC
- Validate affordability against tracked balance/wallet; reject and emit a structured event when blocked
- Make `walletMode: real` require explicit runtime opt-in (env var / CLI flag) and default to safe mode

**Scope:** `src/env/actions.ts` + config plumbing (env/cli) + event logging for rejected trades

---

## Backtest: Multi-Size Candle Aggregation

**Problem:** Currently each backtest dataset stores candles at a single fixed size (e.g. 5s). If an agent wants a different candle size, or wants to subscribe to multiple timeframes simultaneously (e.g. 5s for signals + 60s for trend), it needs separate datasets created at each size.

**Current Workaround:** Create one dataset per candle size:
```bash
cli dataset create --name eurusd-5s  --active 76 --candle-size 5  --from ... --to ...
cli dataset create --name eurusd-60s --active 76 --candle-size 60 --from ... --to ...
cli backtest my-agent --dataset eurusd-5s,eurusd-60s --balance 100
```
This works because `BacktestEnvironment` accepts multiple datasets and `feedCandle` routes each candle to the correct sensor buffer by `active_id + size`. However it requires fetching and storing the same time range twice at different granularities, which is wasteful and error-prone (date ranges must match exactly).

**Proposed Solution:**
- Store the smallest candle size available (e.g. 1s or 5s) in the dataset
- When an agent subscribes to a larger candle size, aggregate on the fly (e.g. twelve 5s candles → one 60s candle)
- Aggregation logic: combine OHLCV — open from first, close from last, min/max across all, sum volumes
- This lets a single dataset serve agents with any candle size >= the stored size
- Multi-timeframe agents (subscribe to both 5s and 60s) work automatically from one dataset
- Aggregation happens in `executeSubscribe` (build initial buffer) and `feedCandle` (accumulate partial candles, emit when complete)

**Constraints:**
- Target size must be an exact multiple of stored size (e.g. 60s from 5s = 12 candles per aggregated candle)
- Sub-second candles are not supported by IQ Option API
- Aggregated candles should have correct `from`/`to` timestamps aligned to the target size boundary

**Scope:** `src/backtest/environment.ts` — candle aggregation in sensor feed + BacktestCandlesAPI

---

## ~~Backtest: Use Simulated Time Everywhere~~ (RESOLVED)

**Problem:** Backtests run on simulated time (`BacktestEnvironment` advances `currentTime` from candle timestamps). If agents use wall-clock time (`Date.now()`) for cooldowns/pauses/TTL, behavior becomes incorrect in backtests (e.g. pausing for hours worth of *real* seconds during a 0.1s backtest).

**Resolution:** Added `now(): number` to `AgentContext` interface. `createAgentContext` accepts an optional `timeFn` parameter — live uses wall clock (default), backtest passes simulated time. All agents updated:
- `macd.ts`, `atrx.ts`, `trend-retest.ts`: `onTradeResult` pause logic uses `ctx.now()` instead of `Date.now()`
- `onObservation` methods already used `obs.timestamp` (which is simulated time in backtest)
- `drl/index.ts`, `momentum.ts`: already used `obs.timestamp || Date.now()` fallback pattern, safe as-is

**Remaining:** Optional lint rule to prevent `Date.now()` in agent code. Low priority since the `ctx.now()` pattern is established.

---

## CLI: Typed --config Parsing (Booleans/JSON)

**Problem:** CLI `--config key=value` currently coerces only numbers. `false` becomes the string `"false"` (truthy), which breaks agent flags like `debug=false` and makes configs error-prone.

**Proposed Solution:** Improve parsing:
- Parse `true|false` into booleans
- Parse `null` into `null`
- Optionally support JSON via `key=@json:{...}` or `key={...}` for nested config

**Scope:** `src/cli/cli.ts` config parser used by `agents run` and `backtest`
