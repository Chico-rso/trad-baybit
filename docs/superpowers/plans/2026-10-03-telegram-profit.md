# Telegram Profit Report Implementation Plan

> **For agentic workers:** Use this plan task by task, with a code review before integration. Execute inline in the isolated `feature/telegram-profit` worktree.

**Goal:** Add the approved `/profit` Telegram report and deploy it while preserving server data.

**Architecture:** SQLite aggregates completed trades by mode and exit time without a row limit. A pure report builder values remaining positions at fresh bid/ask quotes, preserving partial exits and paid fees. Telegram formats the report, and a read-only `/api/profit` resource permits verification against the running instance without sending chat messages.

**Tech Stack:** Existing TypeScript, Node SQLite, Telegram adapter, Vitest, systemd.

## Task 1: Regression tests before implementation

Files: create `tests/telegram/profit.test.ts`.

- [ ] Test `/profit` and `/profit@ExampleBot` parsing and authorized chat routing.
- [ ] Test zero history; positive, negative and break-even closed trades; UTC boundaries based on exitTime; mode isolation; commissions counted once.
- [ ] Test Long bid and Short ask, partial realized gross profit and paid commissions, missing/stale/future/disconnected quotes, and no fabricated valuation.
- [ ] Test allocated capital greater than its initial value after profits; omit capital and percentage when no allocation is configured.
- [ ] Test aggregates over 100,001 rows to guard against the legacy 100,000-row cap.
- [ ] Run `pnpm test tests/telegram/profit.test.ts` and confirm failures reflect the missing feature.

## Task 2: Implement the reporting path

Files: create `src/monitoring/profit.ts`; modify `src/database/db.ts`, `src/trading/TradingEngine.ts`, `src/telegram/commands.ts`, `src/telegram/messages.ts`, `src/api/server.ts`.

- [ ] Define the shared types:

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

- [ ] Add `Journal.profitTotals(mode, since = 0, until = Number.MAX_SAFE_INTEGER)`. Use bound SQL parameters and a single aggregate query on `trades`; filter by mode and `json_extract(payload, '$.exitTime')`, with inclusive since and exclusive until. Sum positive and negative netPnL separately, all fees and netPnL, and count positive/negative/zero records. Empty sums become zero. Do not use LIMIT or list().
- [ ] Build report values from these exact formulas:

```ts
const direction = position.side === 'Long' ? 1 : -1;
const mark = position.side === 'Long' ? quote.bid : quote.ask;
const openResult = position.grossPnL - position.fees
  + (mark - position.entry) * position.quantity * direction;
const totalPnL = closed.netPnL + openPnL;
const currentCapital = initialCapital + totalPnL;
const returnPercent = totalPnL / initialCapital * 100;
```

- [ ] Return null valuation when a held symbol has no synchronized connected book, its timestamp is in the future or older than MARKET_STALE_MS, or the account position state is not synchronized. No positions with synchronized account state produce zero openPnL.
- [ ] Add `TradingEngine.profit(now = Date.now())`; obtain UTC midnight with Date.UTC and two native aggregate queries. Pass positions and synchronized quotes to the builder. Expose `resources().profit`, add the read-only API route and dispatch `command('profit')` to the formatter.
- [ ] Render the approved Russian report with up to six decimal places, explicit signs, informational already-counted commissions, UTC day label, open-PnL estimate caveat and four-decimal percentage. Show unavailable current totals explicitly; mode and complete realized totals remain readable.
- [ ] Run focused tests to green, then typecheck, lint, full tests and build.

## Task 3: Review, publish, deploy and verify

Files: modify `README.md` command/API documentation and approved spec status; update this checklist.

- [ ] Document `/profit`, realized/open calculation and unavailable valuations; document read-only GET /api/profit.
- [ ] Request code review of changes from baseline `74210f3`, fix important findings and rerun affected checks.
- [ ] Commit the feature, fast-forward main and push to the previously authorized repository.
- [ ] Rebuild a production-only bundle locally using the existing `.tools/deploy/runtime-graph.json` packaging method and stamp the new commit.
- [ ] Upload only the release archive. Stop the service gracefully, save a consistent server-side SQLite backup, retain `/etc/trad-baybit/demo.env`, and replace only `/opt/trad-baybit/app` with rollback available.
- [ ] Start service, wait for connected public/private Bybit and non-active kill switch, query `/api/profit`, render the same formatter locally on the server, check current resource usage and both existing sites. Do not reset trading guards.

## Plan review

The read-only API resource is a small operational addition to the approved report: it uses the same data as Telegram and the existing loopback-only HTTP server. It avoids sending unsolicited Telegram test messages. No trading logic, service limits or environment settings need changing.
