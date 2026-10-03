# Implementation plan

Goal: deliver the complete MVP described in the attached request with safe defaults.
Architecture: exchange adapter → stores → strategy → risk → execution; SQLite journal,
read-only HTTP and Telegram supervise the pipeline.

Execute inline in the current workspace; no extra review gate is needed because
the user explicitly requested immediate implementation.

1. Foundation: package scripts, strict compiler, env gates, sanitized logs, SQLite.
   Tests: unsafe live/leverage configurations and durable state rollback. Verify compiler/tests.
2. Public adapter: signed V5 REST, WS heartbeat/reconnect/subscription acknowledgements,
   historical candle initialization, book/trade stores. Tests: local transports and book reset.
3. Indicators and health: EMA/SMA, Wilder RSI/ATR, session VWAP, freshness and synchronization.
   Tests: known numeric vectors, candle gaps and reconnect blocking.
4. Strategy: seven configured weights, 5m hard trend gate, ATR and spread limits,
   persisted indicator snapshots and rejection reasons. Tests: aligned/misaligned signals.
5. Risk: daily baseline/loss guard, consecutive loss/cooldown, position sizing with
   instrument limits, reservations and latched kill switch. Tests: requested rejection cases.
6. Paper: limit expiry, trade-driven fills, executable quotes, stop/TP/breakeven/trailing,
   cost accounting and restart restoration. Tests: gaps, costs, pause and duplicate entries.
7. Private adapter: reconcile balances/positions/orders/executions, authenticated WS,
   unknown exposure blocking, protection verification. Tests: dedup and partial fills.
8. Exchange execution: durable order intents, no blind POST retry, cancel timeout,
   independent live/testnet gates and health preflight. Tests: ambiguous timeout/restart.
9. Notifications/API: authorized Telegram commands, sanitized failures, loopback HTTP.
   Tests: unauthorized commands and read-only status routes.
10. Backtest/docs: historical JSON CLI, chronology and independent train/validation,
    complete README, safe public smoke checks, dependency lock and lint.

For every phase, write relevant tests first, observe failure, implement, then run
`pnpm typecheck` and `pnpm test`. Finish with install/typecheck/test/lint/build and
CLI smoke checks. Record evidence and practical limitations in README/report.
