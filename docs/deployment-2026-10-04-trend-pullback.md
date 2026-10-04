# Trend pullback DEMO deployment, 2026-10-04

User authorized replacing the entry strategy with hourly trend / 15m pullback.
Implemented STRATEGY=trend-pullback; scalping remains available for comparison.
The server service was restarted at 08:16:27 UTC (11:16:27 MSK).

Validation: 187 tests in 27 suites passed; TypeScript, ESLint, Prettier, build and
diff checks passed. Independent review found no blocking correctness issues.
Live status after startup: DEMO, both WebSockets connected, HEALTHY, no kill
switch, not paused, continuous testing retained (lossLimitsEnabled=false).
Three existing protected positions were restored. All 52 predeployment closed
trades remain in the original server-owned SQLite journal. New strategy totals
start separately at zero. The next entries are evaluated at closed 15m bars.

Server backup: /opt/trad-baybit/releases/trend-pullback-20261004T081614Z
contains dist.previous, demo.env.previous, demo.db.previous, status.before.json
and status.verified.json. Only app/dist and the STRATEGY env selection changed.
Initial capital119.78, symbols, risk2%, leverage1 and maximum20 positions remain.
No local database or credentials were copied to the server.

The research comparison is recorded in
[the fixed comparison report](research/2026-10-04-strategy-comparison.md).
New strategy holdout: 9 trades, net -0.1426 USDT including0.7539 fees;
training:15 trades, net -5.7066 USDT. This experiment has not established
profitability. The short sample lacks historical orderbook and funding; slower
trade cadence materially reduces transaction count and expenses.

Rollback: stop trad-baybit gracefully, preserve current dist for inspection,
restore dist.previous and demo.env.previous, then start trad-baybit. Preserve
the current SQLite journal rather than replacing it with the backup: optional
strategy metadata remains backward-compatible with the old application.
