export interface WalletConfig {
  mode: "virtual" | "real";
  initialBalance: number;
}

export class Wallet {
  readonly mode: "virtual" | "real";
  private balance: number;
  private peak: number;
  private maxDrawdown: number;
  private bustCallback: (() => void) | null = null;

  constructor(config: WalletConfig) {
    this.mode = config.mode;
    this.balance = config.initialBalance;
    this.peak = config.initialBalance;
    this.maxDrawdown = 0;
  }

  getBalance(): number {
    return this.balance;
  }

  canAfford(amount: number): boolean {
    return this.balance >= amount;
  }

  debit(amount: number): void {
    this.balance -= amount;
    const dd = this.peak - this.balance;
    if (dd > this.maxDrawdown) this.maxDrawdown = dd;
    if (this.balance <= 0 && this.bustCallback) {
      this.bustCallback();
    }
  }

  credit(amount: number): void {
    this.balance += amount;
    if (this.balance > this.peak) {
      this.peak = this.balance;
    }
  }

  getDrawdown(): number {
    return this.peak - this.balance;
  }

  getMaxDrawdown(): number {
    return this.maxDrawdown;
  }

  getPeak(): number {
    return this.peak;
  }

  snapshot(): { balance: number; peak: number; maxDrawdown: number } {
    return {
      balance: this.balance,
      peak: this.peak,
      maxDrawdown: this.maxDrawdown,
    };
  }

  onBust(cb: () => void): void {
    this.bustCallback = cb;
  }
}
