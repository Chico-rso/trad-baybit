# Reconciliation history window correction

**Goal:** Prevent old completed orders from triggering a six-day history guard
when a new order appears on the same symbol. Preserve the history guard for
genuinely unresolved orders and open positions, and restore authorized DEMO work.

**Evidence:** At 18:15 MSK on October 9 the service activated
`reconciliation history exceeds six days; manual audit required` immediately
after creating a new XRP order. The earliest history timestamp used all orders
whose symbol was pending, including old completed XRP orders. No failed account
reconciliations were logged; current DOGE exposure remains owned and protected.

**Design:** Select unresolved orders individually: active/unknown durable intent
or expected fills exceeding accounted fills, including reduce-only close intents.
Combine their timestamps with open position entry times to bound execution GETs.
Terminal fully accounted orders do not require older execution history. The
six-day guard, delayed-fill confirmation, other kill causes and risk policy stay.

## Steps

- [x] Write regression cases for a new pending entry with a same-symbol old filled,
  cancelled or rejected order; verify no kill and a recent executions startTime.
  Retain tests for real aged entry/exit intents, fill deficits and open positions.
- [x] Run targeted Vitest and observe the terminal-order regressions fail.
- [x] Replace the symbol-based filter with the individual unresolved-order predicate;
  run targeted and full tests, typecheck, lint, formatting, build and diff checks.
- [x] Obtain independent review of the filter and regression boundaries.
- [x] Audit current DEMO account, DOGE quantity/side/entry/native SL/TP/leverage,
  active orders and accounted fills. Back up server SQLite and previous dist;
  install only the verified code with rollback and preserve configuration.
- [x] With the service stopped, clear only the specifically audited history-window
  latch using the existing Journal/FileLock operator reset path. Preserve all
  other state, the owned position and history; restart and verify three successful
  reconciliations, stream connections and retained continuous DEMO policy.
- [x] Record deployment and validation evidence.

## Evidence

The first completed XRP order was just over six days old (timestamp
1791040500818); the new XRP order at timestamp 1791558900857 was cancelled with
zero fills after the guard activated. Both were fully accounted by the audit.
Four regression cases failed against the baseline: three old terminal-order
cases and the previously omitted genuinely old reduce-only close intent.
All 63 exchange tests and 216 tests across 27 suites passed after the correction;
typecheck, ESLint, Prettier, build and diff checks passed. Independent review
approved the change and verified targeted tests/typecheck independently.

Verified compiled module SHA-256:
`1327de7af004e5ef0cf6a586aeaf44de2e4ee405162dc11108bffeb402090bb1`.
Dist-only archive SHA-256:
`a061502967714048bce99dce0ec64a2d91b945f5b52be0172e56c958b446ef05`.
Server backup: `/opt/trad-baybit/releases/history-window-20261009T152427Z`.
Pre-update counts: 88 orders, 149 fills, 75 positions, 74 closed trades.

AUTO_CLOSE_ON_SHUTDOWN=false and DEMO_CONTINUOUS_TESTING=true were confirmed
before stopping the service. With the new compiled code installed and the service
stopped, a GET-only reconciliation validated the account, journal and the DOGE
short: quantity1327, entry0.08487, SL0.08564, TP0.08293, leverage1. There were no
unresolved intents or genuine positions/intents older than six days. The reset
cleared only the history-window latch in an audited transaction, preserving all
other state and native protection; no orders were submitted by the audit.

At 18:25:20 MSK on October 9, verification completed after three distinct
successful reconciliations: HEALTHY, both WebSocket streams connected, kill
switch inactive, paused=false, one open position and no pending symbols.
Continuous DEMO testing remained enabled and loss limits remained disabled.
All four database counts were unchanged, as were the environment file and
SQLite inode/ownership; the installed compiled module matched its verified hash.
Verification status is saved in the server backup as `status.verified.json`.
