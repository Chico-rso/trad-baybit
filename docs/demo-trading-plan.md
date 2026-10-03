# Bybit Demo Trading design and implementation plan

Goal: place exchange-visible demo orders in the Demo Trading account associated
with the user's ordinary Bybit login, using virtual funds only.

The user explicitly chose Demo Trading; implement this extension in the current
workspace. This workspace has no Git repository. Existing `.env`, running PAPER
process, journals and kill latches must remain intact.

Architecture: a distinct `demo` mode uses authenticated REST exclusively at
`https://api-demo.bybit.com`, private WS at
`wss://stream-demo.bybit.com/v5/private`, and public mainnet REST/WS. There is no
fallback to mainnet account endpoints. `ENABLE_LIVE_TRADING=true` is rejected in
DEMO. The existing exchange execution/reconciliation/protection pipeline is reused.
Settings are loaded from `.env.demo` with Node's native `--env-file`, avoiding
the existing `.env`. DEMO has a separate SQLite journal and preserved risk guards.

Official reference: https://bybit-exchange.github.io/docs/v5/demo

1. Write failing tests for demo credentials, immutable REST/WS routing, independent
   LIVE gates, signed demo writes/public unsigned reads, private connectivity health,
   and exchange engine adapter mismatch. Run the new tests and confirm failure.
2. Add demo ENV/endpoint mapping, DemoExecutionEngine, bootstrap mode selection,
   private health requirement and status network. Preserve existing safe defaults.
3. Provide `.env.demo.example` and a blank local `.env.demo` without overwriting
   any file. Provide demo launch and read-only account-check commands. Check script
   must verify account mode/permissions/balance/orders/positions without any POST.
4. Document key creation inside mainnet's Demo Trading UI, virtual funds, one-way
   unified cross margin, terminal commands without pnpm, expected mode/account
   readiness, and display of positions/orders in Bybit Demo Trading.
5. Run full tests, typecheck, lint, format and build. Smoke-check public mainnet
   data and missing-key startup rejection. Authenticated demo verification remains
   pending until the user fills local credentials; send no unauthenticated test orders.

Public mainnet smoke verification found a source-clock skew: fresh orderbook timestamps
were ~50 ms ahead of local time and therefore incorrectly failed `now >= quote.timestamp`.
Add a regression test, convert source timestamps through the already synchronized REST
clock offset, clamp small round-trip estimation errors to receipt time, reject invalid
or more than 1 s future timestamps, and keep old timestamps old. Verify that stale data
still fails. Do not reset the running PAPER latch or modify that process.
