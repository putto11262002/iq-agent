# Changelog

## 2026-02-14 (CLI: Assets, Auth SSID & `iq` command)

### Added
- `iq assets list` command — browse available blitz-option assets (ID, name, payout, min/max bet, deadtime, expiries, status)
- `iq assets list --all` — include disabled/suspended assets
- `iq auth ssid` command — get SSID session token via profile (shows cached status)
- `iq` global command via `bun link` — run `iq <command>` from anywhere instead of `bun run src/cli/cli.ts <command>`

### Changed
- `auth ssid` requires a profile (no .env fallback) — add a profile first with `iq auth add`

---

## 2026-02-14 (CLI Migration)

### Changed
- Migrated CLI (`src/cli/cli.ts`) from hand-rolled argument parser to Yargs with subcommands
- `--config key=value` now properly coerces booleans (`false` → `false`), `null`, numbers, and JSON objects/arrays — previously only coerced numbers, leaving `"false"` as a truthy string
- All commands and subcommands now support `--help` with auto-generated usage, options, and defaults

### Removed
- Manual boolean coercion workaround in `src/bot/agents/atrx.ts` (no longer needed with proper CLI coercion)

### Added
- `yargs` dependency for CLI argument parsing

---

## 2026-02-14

### Added
- `ActionResult` type — `executeActions()` now returns results instead of void
- `TypedSensors` class — type-safe accessor via `obs.typed.candles()`, `.mood()`, etc.
- Balance and instruments sensor types
- `getTradersMood` and `getCandles` query actions
- `getRemainingTime(position)` on `TradingEnvironmentInterface`
- State tracking: `drawdown`, `maxDrawdown`, `peak`, `streak`, `recentClosedPositions`
- Optional fields on `BlitzOptionConfigSchema`: `schedule`, `buyback_deadtime`, `rollover_enabled`, `precision`, `group_id`

### Fixed
- `onTradeResult` now fired by environment (was only called by Runner, causing duplicates)
- Backtest `executeQuery()` returns actual data instead of silently discarding
