# Delayed Fill Reconciliation Implementation Plan

> **For agentic workers:** Use test-driven-development for each task and independent code review before deployment.

**Goal:** Prevent a persisted kill latch for a delayed owned execution while keeping real discrepancies protected.

**Architecture:** Preserve the existing GET confirmation, then persist a bounded confirmation phase in continuous DEMO and return unsynchronized to let the serialized queue process executions. Only explained owned position differences receive this phase; validate protections and unknown exposure immediately. A successful reconciliation clears pending confirmation without clearing kill state. TESTNET/LIVE and ordinary DEMO keep their existing latch timing.

**Tech Stack:** TypeScript, Node SQLite, Bybit V5, Vitest, systemd.

## Task 1: Reproduce delayed data

Files: `tests/trading/exchange.test.ts`.

- [x] Add an owned entry whose execution is absent from both REST reads and arrives through `handleExecutions` after `reconcile` returns. Assert no kill, unsynchronized/entry preflight blocked, native protection ownership, one fill and eventual synchronization without repeated POST.
- [x] Add partial-entry, missing-local close and expected-fill-deficit regressions. Keep the timer bounded across repeated reads and restored engine instances. Check restart, duplicates, unrelated kill, real unknown exposure and SL/TP validation.
- [x] Run `node node_modules/vitest/vitest.mjs run tests/trading/exchange.test.ts`; confirm new tests fail because current code immediately latches.

## Task 2: Bounded confirmation

Files: `src/trading/ExchangeExecutionEngine.ts`.

- [x] Identify unique outstanding entry intents with `pendingEntry`, matching symbol/side and reservation, excluding completed trade IDs. Do not adopt a remote position or invent a fill.
- [x] Include expected-fill deficits in the existing extra executions/positions read trigger.
- [x] Accumulate explained discrepancy reasons; preserve immediate unknown exposure/order, invalid protection, leverage, hedge and payload/accounting guards.
- [x] Persist and check the confirmation deadline using this state transition, leaving `synchronized=false` while reasons exist:

```ts
const key = `reconcilePending:${this.mode}`;
const now = Date.now();
const since = this.db.state<{ since: number } | null>(key)?.since ?? now;
this.db.setState(key, { since, reasons });
if (!Number.isFinite(since) || since > now || now - since >= 30000)
  for (const reason of reasons) this.kill.activate(reason);
```

- [x] On a discrepancy-free reconciliation, clear only pending confirmation with `this.db.setState(key, null)` when present; retain existing kill reasons, accounting and periodic scheduling.
- [x] Run the exchange regressions and adapt former immediate missing-position expectations to the explicit bounded confirmation contract.
- [x] Independent review reproduced a queued SL/TP update falsely latching before its entry fill. Retain validated pending protection owners across callbacks within the same deadline; add positive and expiry/other-symbol/non-reduce-only regressions. Observe the two positive regressions fail before correction, then pass; reviewer approved the corrected implementation.

## Task 3: Verify, review and deploy

Files: `README.md`, this plan; server `/opt/trad-baybit/app/dist` only.

- [x] Document confirmation phase and preserved safeguards.
- [x] Run full Vitest, typecheck, lint, changed-file Prettier, production build and `git diff --check`; independent reviewer checks pending ownership, boundedness, restart, protections and queue semantics.
- [x] Package verified dist without ENV/SQLite/dependencies; upload, stop only `trad-baybit`, back up its dist and consistent server SQLite, install dist and start service. Preserve ENV and SQLite in place; rollback dist if startup verification fails.
- [x] Verify DEMO/continuous policy, fresh successful reconciliations, both streams, no newly activated latch and retained trade counts. Record release backup and actual verification results in this plan.

## Verification evidence

New regressions reproduced the original immediate-latch behavior: 10 failures
against baseline. Independent review then reproduced two failures for SL/TP private
updates queued before the entry execution; the correction passed those cases and
three negative ownership/expiry cases. Final checks: 209 tests in 27 suites passed,
including 56 exchange regressions; typecheck, ESLint, changed-file Prettier,
production build and diff checks passed. Independent reviewer approved the final
implementation after re-review.

Compiled module SHA-256:
`d8ab9e4e7d87b4529d29efba1ec6391982fb2ce208e864d1cfe7fbae32ac8640`.
Production dist-only archive SHA-256:
`ea36b34ec51fe9ec5a8d0d2a1a0d49692972f224c4ac2ef8ca0e29c76e9b3bc3`.

Server release backup:
`/opt/trad-baybit/releases/reconciliation-20261008T195633Z`, containing
`dist.previous`, consistent `demo.db.before`, `status.before.json` and
`counts.before.json`. Pre-update counts: 84 orders, 144 fills, 72 positions,
72 closed trades. Installation replaced only `app/dist`; configuration checksum,
database inode and owner are checked before and after installation. Deployment
automatically restores the previous compiled code on failed startup validation;
it never restores SQLite from a snapshot.

Startup verification counts distinct successful persisted reconciliation timestamps
while requiring a HEALTHY final sample. The expected transient in-memory
`account state unsynchronized` during scheduled REST reads does not erase earlier
successful cycles; real unsynchronized snapshots, disconnects and new kill reasons
still invalidate the observation.

Final server verification at 22:57:13 MSK on 2026-10-08 passed: continuous DEMO,
trend-pullback, HEALTHY, both public/private streams connected, no kill and no
pause, three distinct successful account reconciliation cycles, no open position
or pending symbol. All four journal counts remained unchanged (84/144/72/72),
daily PnL remained +3.21121098 USDT, environment checksum and the original SQLite
inode/owner were preserved, and the installed compiled module matched the verified
SHA-256. The release contains `status.verified.json` with the complete evidence.
