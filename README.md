# IQ Option Blitz Trading Bot

Automated blitz-option trading on IQ Option via their WebSocket API. Supports pluggable agents, real-time market data, and Zod-validated protocol messages.

## Quick Start

```bash
# Install
bun install

# Set credentials
echo 'IQ_EMAIL=you@example.com' >> .env
echo 'IQ_PASSWORD=yourpassword' >> .env

# Run an agent live (connects to IQ Option)
bun run src/cli/cli.ts agents run macd --active 76
bun run src/cli/cli.ts agents run momentum --active 76 --config tradeAmount=50

# List available agents
bun run src/cli/cli.ts agents list

# Backtest an agent offline (no IQ connection needed)
bun run src/cli/cli.ts dataset create --name eurusd-5s --active 76 --candle-size 5 --from 2026-02-10 --to 2026-02-13
bun run src/cli/cli.ts backtest macd --dataset eurusd-5s --balance 100
```

## Architecture

The system is organized into four layers, each depending only on the layer below it.

### Transport Layer

Manages the raw WebSocket connection to `wss://ws.iqoption.com/echo/websocket`. Handles connect/reconnect, JSON frame parsing, and message dispatch by name. The protocol component sits on top, tracking in-flight requests by `request_id` and providing `sendMessage`, `subscribe`, and `unsubscribe` primitives. Authentication is a two-step flow: HTTP login for an SSID token, then a WS `authenticate` message.

### API Layer

Five domain-specific classes that map 1:1 to protocol concerns: **Account**, **Assets**, **Candles**, **Trading**, and **Subscriptions**. Each method sends an RPC or subscribes to a push event, then validates the response through a Zod schema using `safeParse`. On validation failure, a warning is logged and the raw data is returned — this means a protocol change degrades gracefully instead of crashing.

### Environment Layer

The bridge between the IQ Option API and agent code. **TradingEnvironment** orchestrates startup (fetch profile, balance, assets, subscribe to balance updates and position changes), then exposes an observation/action interface. **SensorManager** buffers incoming data streams (candles, mood, positions, orders). **ActionExecutor** translates agent actions (`trade`, `subscribe`, `query`) into API calls. **EnvironmentState** tracks balance, open positions, and win/loss stats — updated in real-time via `balance-changed` and `position-changed` push events.

### Agent Layer

Your trading logic. Agents implement a three-method interface: `initialize` (subscribe to sensors), `onObservation` (receive data, return actions), and `onTradeResult` (handle trade outcomes). The included `MomentumAgent` demonstrates the pattern — it trades on N consecutive bullish/bearish candles.

### Schema Layer

All types are derived from Zod schemas via `z.infer<>`. Schemas live in `src/schemas/`, and `src/types/index.ts` re-exports them as a bridge so imports like `from "../types/index.ts"` work everywhere. Notable quirks the schemas handle:
- Server sends `min`/`max` for candles — `CandleSchema` transforms these to `low`/`high` aliases
- Server spells it `"loose"` not `"lose"` — `PositionSchema` matches the server spelling
- `balance-changed` wraps data in `{ current_balance: { ... } }` — `BalanceChangedSchema` unwraps this

## CLI

All commands go through `bun run src/cli/cli.ts <command>`.

### Live Trading

```bash
# List registered agents
bun run src/cli/cli.ts agents list

# Run an agent (connects to IQ Option WebSocket)
bun run src/cli/cli.ts agents run <agentName> --active <id> [--config key=value ...]

# Examples
bun run src/cli/cli.ts agents run macd --active 76
bun run src/cli/cli.ts agents run macd --active 76 --config tradeAmount=50 expirationSize=30
```

### Dataset Management

Datasets store historical candle data in SQLite for offline backtesting. Creating a dataset requires an IQ Option connection (one-time); after that, all backtests run fully offline.

```bash
# Create a dataset (fetches candles from IQ Option)
bun run src/cli/cli.ts dataset create --name eurusd-5s --active 76 --candle-size 5 --from 2026-02-10 --to 2026-02-13

# List datasets
bun run src/cli/cli.ts dataset list

# Delete a dataset
bun run src/cli/cli.ts dataset delete eurusd-5s
```

### Backtesting

Run agents against historical data at full speed — no waiting for real-time candles.

```bash
# Basic backtest
bun run src/cli/cli.ts backtest macd --dataset eurusd-5s --balance 100

# Multiple datasets
bun run src/cli/cli.ts backtest macd --dataset eurusd-5s,eurusd-jan --balance 100

# Override payout percentage
bun run src/cli/cli.ts backtest macd --dataset eurusd-5s --balance 100 --payout 85

# Pass agent config overrides
bun run src/cli/cli.ts backtest macd --dataset eurusd-5s --balance 100 --config tradeAmount=10
```

Output includes: trades, win rate, PnL, max drawdown, final balance, and a run ID. Use the run ID with `events`, `stats`, or `replay` commands for further analysis.

### Observability

```bash
# View events for a run
bun run src/cli/cli.ts events <runId>

# View run stats
bun run src/cli/cli.ts stats <runId>

# Replay event timeline
bun run src/cli/cli.ts replay <runId>
```

## Writing a New Agent

Implement the `Agent` interface from `src/env/types.ts`:

```ts
interface Agent {
  name: string;
  initialize(env: TradingEnvironmentInterface, ctx?: AgentContext): Promise<void>;
  onObservation(obs: Observation): Promise<Action[]>;
  onTradeResult(position: Position): void;
}
```

### Minimal Example

```ts
// src/bot/agents/my-agent.ts
import type { Position } from "../../types/index.ts";
import type { Agent, Action, Observation, TradingEnvironmentInterface } from "../../env/types.ts";
import type { AgentContext } from "../../env/agent-context.ts";
import { SensorManager } from "../../env/sensors.ts";

export class MyAgent implements Agent {
  name = "MyAgent";
  private ctx: AgentContext | undefined;
  private balanceId = 0;
  private activeId: number;

  constructor(activeId: number) {
    this.activeId = activeId;
  }

  async initialize(env: TradingEnvironmentInterface, ctx?: AgentContext): Promise<void> {
    this.ctx = ctx;
    this.balanceId = env.getBalanceId();

    // Subscribe to 1-second candles
    await env.executeActions([{
      type: "subscribe",
      payload: {
        id: SensorManager.candleId(this.activeId, 1),
        type: "candle",
        params: { active_id: this.activeId, size: 1 },
      } as Record<string, unknown>,
    }]);
  }

  async onObservation(obs: Observation): Promise<Action[]> {
    const candles = obs.sensors.get(SensorManager.candleId(this.activeId, 1));
    if (!candles || candles.length < 10) return []; // wait for data

    // Your logic here — return actions or empty array
    return [];
  }

  onTradeResult(position: Position): void {
    console.log(`${position.close_reason}: PnL ${position.pnl}`);
  }
}
```

### What's Available in `Observation`

| Field | Type | Contents |
|---|---|---|
| `obs.sensors` | `Map<string, unknown[]>` | Buffered sensor data (last 100 values per sensor) |
| `obs.state.balance` | `number` | Current balance (real-time via `balance-changed`) |
| `obs.state.openPositions` | `Position[]` | Currently open trades |
| `obs.state.closedCount` | `number` | Total closed trades this session |
| `obs.state.winCount` / `lossCount` | `number` | Win/loss counters |
| `obs.state.totalPnl` | `number` | Cumulative P&L |
| `obs.state.availableAssets` | `BlitzOptionConfig[]` | Tradeable assets with payout info |
| `obs.state.serverTime` | `number` | Server unix timestamp (seconds) |
| `obs.timestamp` | `number` | Same as serverTime |

### Available Actions

Return these from `onObservation()`:

```ts
// Place a trade
{ type: "trade", payload: {
    activeId: 76, direction: "call", price: 30,
    balanceId: this.balanceId, expirationSize: 60,
    profitPercent: 86, currentPrice: 1.1234,
}}

// Subscribe to a sensor
{ type: "subscribe", payload: {
    id: "candle:76:60", type: "candle",
    params: { active_id: 76, size: 60 },
}}

// Unsubscribe
{ type: "unsubscribe", payload: { sensorId: "candle:76:60" } }

// Query data (positions, orders, history, balances, assets)
{ type: "query", payload: { method: "getPositions", params: { balanceId: 123 } } }
```

### Sensor Types

| Type | ID Format | Data Type | Source |
|---|---|---|---|
| `candle` | `candle:{activeId}:{size}` | `Candle` | `candle-generated` subscription |
| `mood` | `mood:{activeId}` | `number` (0-1) | `traders-mood-changed` subscription |
| `position` | `position:{balanceId}` | `Position` | `portfolio.position-changed` subscription |
| `order` | `order:{userId}` | `Order` | `portfolio.order-changed` subscription |

### Registering Your Agent

Add your agent to the factory in `src/bot/agents/index.ts` so the CLI can load it:

```ts
// In your agent file, export a factory function:
export function createAgent(config: Record<string, unknown>): Agent {
  return new MyAgent(config);
}
```

Then run it: `bun run src/cli/cli.ts agents run my-agent --active 76`

Agents run identically in live and backtest — the same code, same interface, no changes needed.

### AgentContext

The optional `ctx` parameter in `initialize` provides:

| Method / Field | Description |
|---|---|
| `ctx.now()` | Current time (seconds). Server time in live, simulated time in backtest. Use this instead of `Date.now()`. |
| `ctx.runId` | Unique run identifier |
| `ctx.events.emit(type, payload)` | Emit agent events (must be `agent:*` prefixed) |
| `ctx.events.on(type, handler)` | Listen for events |
| `ctx.wallet.getBalance()` | Current wallet balance |
| `ctx.wallet.getDrawdown()` | Current drawdown |
| `ctx.wallet.getMaxDrawdown()` | Peak drawdown |
| `ctx.trades.getHistory()` | Fetch trade history for this run |
| `ctx.log.debug(msg, data?)` | Emit debug event |
| `ctx.log.signal(dir, confidence, reasons)` | Emit signal event |

**Important:** Always use `ctx.now()` (or `obs.timestamp`) for time-dependent logic like cooldowns and pause timers. Using `Date.now()` will break in backtests where simulated time differs from wall clock.

### Helpers

```ts
// Remaining seconds on an open position
const remaining = env.getRemainingTime(position);

// Get historical candles via environment
const api = env.getCandlesAPI();
const candles = await api.getCandles(activeId, 60, fromTs, toTs);
```

## Testing

```bash
# Run all tests (contract + protocol + drift)
bun test

# Capture fresh fixtures from live server (requires credentials)
bun run src/test/capture-fixtures.ts

# Type check
bunx tsc --noEmit
```

### Contract Tests

`src/test/contract.test.ts` validates every Zod schema against real server fixtures stored in `src/test/fixtures/`. When the protocol changes:

1. Run `bun run src/test/capture-fixtures.ts` to refresh fixtures
2. Run `bun test` — failing tests reveal schema drift
3. Update the schema, run tests again

### Adding Tests for a New Schema

```ts
import { MySchema } from "../schemas/index.ts";
import fixture from "./fixtures/my-fixture.json";

test("fixture matches MySchema", () => {
  const result = MySchema.safeParse(fixture);
  expect(result.success).toBe(true);
});
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `IQ_EMAIL` | Yes | - | IQ Option account email |
| `IQ_PASSWORD` | Yes | - | IQ Option account password |
| `API_URL` | No | `http://localhost:4400` | Server URL for event persistence and run tracking |

Agent-specific settings (trade amount, expiration, candle size) are configured via `--config key=value` CLI flags rather than environment variables.

## Data Storage

All data is stored in `data/trading.db` (SQLite with WAL mode):

| Table | Purpose |
|---|---|
| `runs` | Run metadata (agent, config, start/stop time, status) |
| `trades` | Individual trade records (entry/exit price, PnL, result) |
| `events` | Full event log (every action, trade, position change) |
| `snapshots` | Periodic wallet snapshots (balance, drawdown over time) |
| `datasets` | Backtest dataset metadata (asset, candle size, date range) |
| `dataset_candles` | Historical candle OHLCV data for backtesting |

## Protocol Reference

See [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the full reverse-engineered WebSocket protocol documentation including message formats, RPC catalog, subscription matrix, and payload examples.
