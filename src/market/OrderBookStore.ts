import type { Quote } from '../exchange/bybit/types.js';
export interface BookUpdate {
  b: string[][];
  a: string[][];
  u: number;
  seq: number;
}
export class OrderBookStore {
  private readonly bids = new Map<number, number>();
  private readonly asks = new Map<number, number>();
  private update = 0;
  private sequence = 0;
  private timestamp = 0;
  valid = false;
  constructor(private readonly levels = 10) {}
  reset(): void {
    this.bids.clear();
    this.asks.clear();
    this.valid = false;
    this.update = 0;
    this.sequence = 0;
    this.timestamp = 0;
  }
  apply(type: 'snapshot' | 'delta', data: BookUpdate, timestamp: number): boolean {
    if (type === 'snapshot' || data.u === 1) this.reset();
    else {
      if (!this.valid || data.u < this.update || data.seq < this.sequence) {
        this.reset();
        return false;
      }
      if (data.u === this.update) return true; // retransmission is not a fresh update
    }
    for (const [map, rows] of [
      [this.bids, data.b],
      [this.asks, data.a],
    ] as const) {
      for (const [p, q] of rows) {
        const price = Number(p),
          qty = Number(q);
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty < 0) {
          this.reset();
          return false;
        }
        if (qty === 0) map.delete(price);
        else map.set(price, qty);
      }
    }
    this.update = data.u;
    this.sequence = data.seq;
    this.timestamp = timestamp;
    this.valid = true;
    if (!this.quote()) {
      this.reset();
      return false;
    }
    return true;
  }
  quote(): Quote | undefined {
    if (!this.valid) return;
    const bids = [...this.bids].sort((a, b) => b[0] - a[0]).slice(0, this.levels);
    const asks = [...this.asks].sort((a, b) => a[0] - b[0]).slice(0, this.levels);
    const bid = bids[0]?.[0],
      ask = asks[0]?.[0];
    if (!bid || !ask || bid >= ask) return;
    const bv = bids.reduce((s, v) => s + v[1], 0),
      av = asks.reduce((s, v) => s + v[1], 0);
    if (av <= 0 || bv <= 0) return;
    return { bid, ask, timestamp: this.timestamp, imbalance: bv / av };
  }
}
