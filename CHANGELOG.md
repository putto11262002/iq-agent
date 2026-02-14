# Changelog

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
