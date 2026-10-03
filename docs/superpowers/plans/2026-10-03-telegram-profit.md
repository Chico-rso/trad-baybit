# Telegram Profit Report Implementation Plan

> **For agentic workers:** Use this plan task by task, with a code review before integration. Execute inline in the isolated `feature/telegram-profit` worktree.

**Goal:** Add the approved `/profit` Telegram report and deploy it while preserving server data.

**Architecture:** SQLite aggregates completed trades by mode and exit time without a row limit. A pure report builder values remaining positions at fresh bid/ask quotes, preserving partial exits and paid fees. Telegram formats the report, and a read-only `/api/profit` resource permits verification against the running instance without sending chat messages.

**Tech Stack:** Existing TypeScript, Node SQLite, Telegram adapter, Vitest, systemd.

## Task 1: Regression tests before implementation

Files: create `tests/telegram/profit.test.ts`.

- [x] Test `/profit` and `/profit@ExampleBot` parsing and authorized chat routing.
- [x] Test zero history; positive, negative and break-even closed trades; UTC boundaries based on exitTime; mode isolation; commissions counted once.
- [x] Test Long bid and Short ask, partial realized gross profit and paid commissions, missing/stale/future/disconnected quotes, and no fabricated valuation.
- [x] Test allocated capital greater than its initial value after profits; omit capital and percentage when no allocation is configured.
- [x] Test aggregates over 100,001 rows to guard against the legacy 100,000-row cap.
- [x] Run `pnpm test tests/telegram/profit.test.ts` and confirm failures reflect the missing feature.

## Task 2: Implement the reporting path

Files: create `src/monitoring/profit.ts`; modify `src/database/db.ts`, `src/trading/TradingEngine.ts`, `src/telegram/commands.ts`, `src/telegram/messages.ts`, `src/api/server.ts`.

- [x] Define the shared types:

```ts
export interface ClosedProfit {
  totalTrades: number;
  wins: number;
  losses: number;
  breakEven: number;
  winningPnL: number;
  losingPnL: number;
  netPnL: number;
  fees: number;
}
export interface ProfitReport {
  mode: Mode;
  allTime: ClosedProfit;
  today: ClosedProfit;
  openPositions: number;
  openPnL: number | null;
  totalPnL: number | null;
  initialCapital: number | null;
  currentCapital: number | null;
  returnPercent: number | null;
}
```

- [x] Add `Journal.profitTotals(mode, since = 0, until = Number.MAX_SAFE_INTEGER)`. Use bound SQL parameters and a single aggregate query on `trades`; filter by mode and `json_extract(payload, '$.exitTime')`, with inclusive since and exclusive until. Sum positive and negative netPnL separately, all fees and netPnL, and count positive/negative/zero records. Empty sums become zero. Do not use LIMIT or list().
- [x] Build report values from these exact formulas:

```ts
const direction = position.side === 'Long' ? 1 : -1;
const mark = position.side === 'Long' ? quote.bid : quote.ask;
const openResult = position.grossPnL - position.fees
  + (mark - position.entry) * position.quantity * direction;
const totalPnL = closed.netPnL + openPnL;
const currentCapital = initialCapital + totalPnL;
const returnPercent = totalPnL / initialCapital * 100;
```

- [x] Return null valuation when a held symbol has no synchronized connected book, its timestamp is in the future or older than MARKET_STALE_MS, or the account position state is not synchronized. No positions with synchronized account state produce zero openPnL.
- [x] Add `TradingEngine.profit(now = Date.now())`; obtain UTC midnight with Date.UTC and two native aggregate queries. Pass positions and synchronized quotes to the builder. Expose `resources().profit`, add the read-only API route and dispatch `command('profit')` to the formatter.
- [x] Render the approved Russian report with up to six decimal places, explicit signs, informational already-counted commissions, UTC day label, open-PnL estimate caveat and four-decimal percentage. Show unavailable current totals explicitly; mode and complete realized totals remain readable.
- [x] Run focused tests to green, then typecheck, lint, full tests and build.

## Task 3: Review, publish, deploy and verify

Files: modify `README.md` command/API documentation and approved spec status; update this checklist.

- [x] Document `/profit`, realized/open calculation and unavailable valuations; document read-only GET /api/profit.
- [x] Request code review of changes from baseline `74210f3`, fix important findings and rerun affected checks.
- [x] Commit the feature, fast-forward main and push to the previously authorized repository.
- [x] Rebuild a production-only bundle locally using the existing `.tools/deploy/runtime-graph.json` packaging method and stamp the new commit.
- [x] Upload only the release archive. Stop the service gracefully, save a consistent server-side SQLite backup, retain `/etc/trad-baybit/demo.env`, and replace only `/opt/trad-baybit/app` with rollback available.
- [x] Start service, wait for connected public/private Bybit and non-active kill switch, query `/api/profit`, render the same formatter locally on the server, check current resource usage and both existing sites. Do not reset trading guards.

## Plan review

The read-only API resource is a small operational addition to the approved report: it uses the same data as Telegram and the existing loopback-only HTTP server. It avoids sending unsolicited Telegram test messages. No trading logic, service limits or environment settings need changing.

## Completion evidence

Implemented and deployed on 2026-10-03 from commit `631a4886615dd292db5d95e6962de1eff3e10f1d`. All 102 tests, typecheck, lint and build passed; independent review found no actionable issues. The live `/api/profit` values and compiled Telegram formatter were verified against the running DEMO instance. Bybit was HEALTHY after deployment, both existing websites and the football bot health endpoint returned HTTP 200. Server SQLite and environment settings were retained; rollback files are in `/var/backups/trad-baybit-update-20261003T144802Z`.
