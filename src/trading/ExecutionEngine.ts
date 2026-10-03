import type {
  Signal,
  Quote,
  PublicTrade,
  Order,
  Position,
  ExitReason,
} from '../exchange/bybit/types.js';
import type { SizedPlan } from '../risk/PositionSizer.js';
export function pendingEntry(order: Order): boolean {
  return (
    !order.reduceOnly &&
    (['created', 'new', 'partially_filled', 'unknown'].includes(order.state) ||
      (order.expectedFilledQuantity ?? 0) > order.filledQuantity + 1e-9)
  );
}
export interface ExecutionEngine {
  readonly orders: Map<string, Order>;
  readonly positions: Map<string, Position>;
  submit(signal: Signal, plan: SizedPlan, quote: Quote, now?: number): Promise<void>;
  onQuote(symbol: string, quote: Quote, now?: number): Promise<void>;
  onTrade(trade: PublicTrade): Promise<void>;
  cancelEntries(): Promise<void>;
  closeAll(reason: ExitReason): Promise<void>;
  pendingSymbols(): string[];
  equity(): number;
}
