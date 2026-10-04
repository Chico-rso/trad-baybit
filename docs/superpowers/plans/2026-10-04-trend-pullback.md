# Trend pullback implementation plan

> Execute with subagent-driven-development and test-driven-development.

**Goal:** Replace DEMO entry selection with a testable 15m/60m pullback strategy.

**Architecture:** Select a strategy through a shared factory; keep execution and
journaling compatible with legacy positions. Extend data and replay to the same
native timeframes, and label strategy results separately.

**Tech Stack:** TypeScript, Node 22, Vitest, SQLite, Bybit v5.

- [x] Strategy: write failing directional/pullback/cost/closed-bar/gap tests in
  tests/strategy/pullback.test.ts, run them, then implement
  src/strategy/TrendPullbackStrategy.ts and createStrategy.ts; add validated
  STRATEGY and PULLBACK_* configuration and strategyTimeframes(config).
- [x] Data: write tests proving 15m/60m candle storage, health readiness, native
  feed subscriptions, REST synchronization and confirmed entry events; extend
  CandleInterval, CandleStore, MarketState, BybitClient and BybitMarketData.
- [x] Replay: generalize aggregateFiveMinute into aggregateCandles(interval),
  keeping its wrapper; test incomplete/gapped/multi-symbol aggregation and
  once-per-entry-bar evaluation without lookahead; use selected strategy in
  runner and expose selection in CLI. Add a credential-free fixed comparison
  script using the existing six-symbol dataset and final two-day holdout.
- [x] Integration: test engine interval gating, strategy-specific candle keys,
  trade tagging, frozen protection, normalized net cost checks and separate
  profit/status reporting. Implement these while retaining legacy behavior.
- [x] Verification: run full Vitest, typecheck, lint, formatting and build;
  execute historical comparison; request independent review and fix findings.
- [x] Deploy: inspect launch/version, back up server-owned assets, update built
  app and STRATEGY only, restart gracefully, verify health/history/DEMO routing
  and document actual historical results and deployment timestamps.

Commands: node node_modules/vitest/vitest.mjs run;
node node_modules/typescript/bin/tsc --noEmit;
node node_modules/eslint/bin/eslint.js src tests scripts;
node node_modules/prettier/bin/prettier.cjs --check src tests scripts;
node node_modules/typescript/bin/tsc -p tsconfig.build.json;
node --import tsx scripts/compare-strategies.ts.
