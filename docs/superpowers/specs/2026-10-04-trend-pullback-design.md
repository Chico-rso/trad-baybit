# Trend pullback DEMO strategy

The user approved implementing the proposed hourly-trend / 15-minute-pullback
approach on 2026-10-04. This approval covers implementation, historical evaluation,
and replacing the DEMO entry strategy. It does not enable LIVE.

Use STRATEGY=scalping|trend-pullback, keeping scalping as the default for existing
installations. The server will select trend-pullback. The alternative of tuning
the existing minute scalper lacks positive historical evidence; mean reversion
adds a different market assumption and is outside this experiment.

Evaluate confirmed, contiguous 15m bars against confirmed 60m bars. Require at
least max(EMA_TREND+10, ATR_PERIOD+1, RSI_PERIOD+1, VOLUME_PERIOD+1) bars of each.
Hourly EMA21 versus EMA50, EMA21 slope over three bars, and price relative to
EMA50 must agree. EMA separation must exceed 0.25 hourly ATR. Entry EMA21/EMA50
must agree as well. A bar among the previous four must intersect EMA21 within
0.25 entry ATR. The current candle must close past the previous candle's high
(long) or low (short), have a directional body, and remain within 1.5 ATR of
EMA21. RSI must lie in the configured directional range; excessive spread,
volatility, stale quotes, incomplete bars and gaps reject entry. Volume and book
are recorded but not required: volume spikes and instantaneous orderbook
imbalance should not force slower entries.

Stop distance is max(1.5 entry ATR, distance beyond the pullback extreme with
0.2 ATR buffer). Target is 2.5 stop distances. Conservative round-trip costs use
two taker fees and two slippage allowances; require net reward/net loss >=1.5
and stop distance >=3 times costs. Recheck costs after tick normalization in the
position sizer. New signals freeze breakeven/trailing settings: breakeven at
1.5R, trailing disabled. Existing signals retain their prior protection policy.

Live feed fetches and subscribes to native 15m/60m candles plus 1m quotes/candles
for continuity and existing execution. Both strategies use the same execution,
account synchronization, allocated capital and position sizing pipeline. Record
strategy on signals/trades; legacy trades count as scalping. Show the active
strategy and its closed-trade totals separately in status/profit reports.

Replay aggregates complete UTC-aligned entry/trend intervals from minute data,
exposes bars only after their close, evaluates each entry close once, and submits
at the next minute. Compare frozen configurations on the same six-market dataset
and separate final two-day holdout. Preserve actual execution costs; disclose
missing historical book/funding and the short sample. A negative or sparse
historical result is not proof of profitability and must be reported honestly.

Deployment preserves server env secrets, SQLite, initial capital, symbols,
DEMO_CONTINUOUS_TESTING=true and existing risk-size settings. Back up server
code/env/database before updating only built application files and strategy
selection. Graceful shutdown cancels pending old entries, leaves protected open
positions intact, and the new process reconciles them before new entries. Verify
DEMO routing, health, new strategy selection, retained history and unchanged
continuous testing. Restore prior code/config on startup failure.
