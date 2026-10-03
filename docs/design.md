# Bybit scalping MVP — 2026-10-03

The user's attached specification authorizes implementation in this workspace.
Existing `.env` remains untouched. No external messages or orders are sent during development.

## Design

Use strict TypeScript on Node 24 LTS (Node 22.13+ supported), built-in SQLite,
Zod, Pino, decimal.js and ws. A thin V5 adapter owns all exchange traffic.
SIGNAL and PAPER default to public Testnet data; an explicit market-data setting
may use public mainnet, without enabling authenticated mainnet operations.
TESTNET authenticated endpoints are immutable; LIVE requires two independent flags,
checked both at configuration and execution boundaries.

REST bootstraps instrument metadata and closed candles; WS streams both timeframes,
depth 50 book and public trades. Each reconnect invalidates market synchronization;
new entries need fresh snapshots and candle backfill. Bybit `seq` is a cross sequence,
not a guaranteed contiguous counter: regressions invalidate the book, forward jumps
alone do not prove packet loss. TCP delivery, reconnect invalidation and stale checks
provide the remaining continuity guards.

Strategy evaluates only closed 1m candles, with closed 5m confirmation. Seven weighted
factors produce a heuristic score; risk independently rejects stale, unprotected,
oversized, pending, duplicate or unhealthy entries. Quantity includes conservative
fees/slippage allowance and margin limits, with decimal normalization.

SQLite durably records intent before sending orders and deduplicates fills. Ambiguous
POST outcomes are reconciled by link ID, never blindly retried. Private WS plus REST
reconciliation supervise partial fills, exchange protection and account-wide exposure.
Unknown exposure latches the kill switch. Pause and kill only stop new entries.

PAPER uses quote/trade-driven fills and adverse stop gaps; backtest uses the same
strategy and paper costs with next-bar execution. OHLC lacks historical L2, so book
imbalance is neutral and explicitly reported; no fabricated orderbook confirmation.
Training and validation run independently with fresh state and warmup.

HTTP read-only API binds loopback. Telegram restricts chat IDs; mode is read-only.
Shutdown cancels bot entry orders, persists state, and leaves positions protected
unless automatic close is explicitly enabled.

## Validation

Unit and local HTTP/WS integration tests cover gates, indicators, normalization,
book reconstruction, persistence, risk, simulated execution, timeout ambiguity,
private fill deduplication, backtest chronology and authorized Telegram commands.
Network smoke checks use public Testnet only. Live is never run during development.
Exchange/account-specific acceptance and profitability remain unverified until
the user completes paper and Testnet trials.
