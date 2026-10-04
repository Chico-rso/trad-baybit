export type CandleInterval = 1 | 5 | 15 | 60;

export interface Candle {
  symbol: string;
  interval: CandleInterval;
  start: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
  confirmed: boolean;
}
export interface Instrument {
  symbol: string;
  tickSize: string;
  qtyStep: string;
  minOrderQty: string;
  maxOrderQty: string;
  maxMarketOrderQty: string;
  minNotional: string;
  maxLeverage: number;
}
export interface Quote {
  bid: number;
  ask: number;
  timestamp: number;
  imbalance: number;
}
export interface PublicTrade {
  id: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  price: number;
  quantity: number;
  timestamp: number;
}
export type Side = 'Long' | 'Short';
export type ExitReason =
  'take_profit' | 'stop_loss' | 'manual' | 'strategy_exit' | 'daily_guard' | 'shutdown';
export interface Signal {
  strategy?: 'scalping' | 'trend-pullback';
  protection?: {
    breakevenEnabled: boolean;
    breakevenTriggerR: number;
    trailingStopEnabled: boolean;
    trailingAtrMultiplier: number;
  };
  id: string;
  symbol: string;
  timestamp: number;
  candleStart: number;
  side: Side;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  score: number;
  decision: 'accepted' | 'rejected';
  reasons: string[];
  rejections: string[];
  snapshot: {
    price: number;
    ema9: number;
    ema21: number;
    ema50: number;
    rsi: number;
    atr: number;
    vwap: number;
    volume: number;
    volumeAverage: number;
    spread: number;
    imbalance: number;
    trendEma21: number;
    trendEma50: number;
  };
}
export type OrderState =
  'created' | 'new' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected' | 'unknown';
export interface Order {
  id: string;
  exchangeId?: string;
  expectedFilledQuantity?: number;
  mode: string;
  symbol: string;
  side: Side;
  quantity: number;
  filledQuantity: number;
  entry: number;
  type: 'Market' | 'Limit';
  state: OrderState;
  timestamp: number;
  signal: Signal;
  reduceOnly?: boolean;
}
export interface Position {
  id: string;
  mode: string;
  symbol: string;
  side: Side;
  quantity: number;
  initialQuantity: number;
  entry: number;
  entryCost?: number;
  entryTime: number;
  stopLoss: number;
  initialStopLoss: number;
  takeProfit: number;
  fees: number;
  estimatedSlippage: number;
  grossPnL: number;
  exitValue: number;
  exitQuantity: number;
  signal: Signal;
  breakeven: boolean;
  trailingAnchor: number;
  closed?: boolean;
  closing?: boolean;
  exitReason?: ExitReason;
}
export interface Fill {
  id: string;
  orderId: string;
  symbol: string;
  mode: string;
  side: 'Buy' | 'Sell';
  price: number;
  quantity: number;
  fee: number;
  timestamp: number;
}
export interface Trade {
  strategy?: 'scalping' | 'trend-pullback';
  id: string;
  mode: string;
  symbol: string;
  side: Side;
  entryTime: number;
  exitTime: number;
  entry: number;
  exit: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  grossPnL: number;
  fees: number;
  estimatedSlippage: number;
  netPnL: number;
  signalScore: number;
  signalReasons: string[];
  exitReason: ExitReason;
}
export interface ExchangeOrder {
  orderId: string;
  orderLinkId: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  qty: string;
  orderStatus: string;
  cumExecQty: string;
  avgPrice: string;
  createdTime: string;
  updatedTime: string;
  reduceOnly: boolean;
  stopOrderType?: string;
  price: string;
  orderType: 'Market' | 'Limit';
}
export interface ExchangePosition {
  symbol: string;
  size: string;
  side: string;
  avgPrice: string;
  positionIdx: number;
  stopLoss: string;
  takeProfit: string;
  leverage: string;
}
export interface ExchangeFill {
  execId: string;
  orderId: string;
  orderLinkId: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  execQty: string;
  execPrice: string;
  execFee: string;
  execTime: string;
  execType: string;
  closedSize: string;
  stopOrderType?: string;
}
export interface OrderRequest {
  category: 'linear';
  symbol: string;
  side: 'Buy' | 'Sell';
  orderType: 'Market' | 'Limit';
  qty: string;
  orderLinkId: string;
  positionIdx: 0;
  price?: string;
  timeInForce?: 'PostOnly' | 'GTC' | 'IOC';
  stopLoss?: string;
  takeProfit?: string;
  tpslMode?: 'Full';
  slOrderType?: 'Market';
  tpOrderType?: 'Market';
  slTriggerBy?: 'LastPrice';
  tpTriggerBy?: 'LastPrice';
  reduceOnly?: boolean;
}
