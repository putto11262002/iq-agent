export interface BacktestConfig {
  agentName: string;
  agentConfig: Record<string, unknown>;
  datasetNames: string[];
  initialBalance: number;
  payoutPercent?: number;
}

export interface BacktestResult {
  runId: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  pnl: number;
  maxDrawdown: number;
  finalBalance: number;
  durationCandles: number;
}

export interface PendingTrade {
  id: number;
  direction: "call" | "put";
  activeId: number;
  invest: number;
  openQuote: number;
  openTime: number;
  expirationTime: number;
  expirationSize: number;
  profitPercent: number;
}
