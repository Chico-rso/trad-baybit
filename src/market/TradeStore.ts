import type { PublicTrade } from '../exchange/bybit/types.js';
export class TradeStore {
  private readonly trades = new Map<string, PublicTrade[]>();
  constructor(private readonly capacity = 1000) {}
  add(trade: PublicTrade): boolean {
    const list = this.trades.get(trade.symbol) ?? [];
    if (list.some((t) => t.id === trade.id)) return false;
    list.push(trade);
    this.trades.set(trade.symbol, list.slice(-this.capacity));
    return true;
  }
  get(symbol: string): PublicTrade[] {
    return this.trades.get(symbol) ?? [];
  }
}
