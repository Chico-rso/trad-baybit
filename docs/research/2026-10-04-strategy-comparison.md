# Fixed strategy comparison

History: 2026-09-26T10:10:00.000Z – 2026-10-03T10:08:00.000Z. Final two-day holdout starts 2026-10-01T10:08:00.000Z.

Initial equity: 119.78 USDT. Limit GTC, timeout 60s, leverage 1, risk 2%, maximum 20 positions.

| Strategy | Period | Trades | Net PnL USDT | Fees USDT | Win rate | Profit factor | Max drawdown |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| scalping | training | 803 | -82.2760 | 46.0943 | 13.1% | 0.262 | 68.69% |
| scalping | holdout | 455 | -22.5289 | 25.2958 | 15.6% | 0.654 | 18.81% |
| trend-pullback | training | 15 | -5.7066 | 1.1208 | 13.3% | 0.025 | 6.33% |
| trend-pullback | holdout | 9 | -0.1426 | 0.7539 | 22.2% | 0.962 | 3.21% |

- Both presets fixed before running; no tuning or selection from the final two-day holdout.
- Short exploratory historical sample, not evidence of reliable future profitability.
- No historical order book: neutral imbalance, fixed spread and approximate minute-based limit fills.
- Funding is not modeled; entry and exit fees, spread and configured slippage are modeled.
- Adverse intrabar extreme precedes favorable extreme; replay cannot recover actual tick ordering.
- Warmup only before holdout; positions, equity and guards reset independently for each replay.
- DEMO continuous-testing loss-guard policy is the same for both presets; margin and order checks remain.
