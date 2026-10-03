# Confirm exchange closure and publish Telegram commands

> **For agentic workers:** Use subagent-driven-development to implement the tasks with TDD and review.

**Goal:** Avoid a latched stop when a real close fill arrives between REST snapshots, and make existing Telegram commands selectable.

**Architecture:** Keep reconciliation unsynchronized until the final snapshot is validated. When a local position is missing from the first remote snapshot, perform one additional executions GET and positions GET, account real fills using the existing ledger, and validate the refreshed snapshot with all existing rules. Register the existing command list in the authorized Telegram chat with Russian descriptions; keep historical update discard and authorization.

**Tech Stack:** TypeScript, Node SQLite, Bybit V5, Telegram Bot API, Vitest.

## Task 1: Closing position reconciliation

Files: `src/trading/ExchangeExecutionEngine.ts`, `src/telegram/messages.ts`, `tests/trading/exchange.test.ts`, `tests/telegram/telegram.test.ts`.

- [x] Write regressions for a closed position missing from the first positions reply, whose close fill appears in the second executions reply; assert no kill, no open position, one persisted trade and no repeated POST. Cover duplicate fills/restart, an existing unrelated latch, persistent missing position, an additional GET failure, and full validation of the refreshed positions (unknown exposure/protection/quantity).
- [x] Run `node node_modules/vitest/vitest.mjs run tests/trading/exchange.test.ts tests/telegram/telegram.test.ts`; the new closing-race test must fail against the baseline because the latch activates.
- [x] Replace the first executions query's expression with a reusable bounded `startTime`. After resolving orders and reading the first positions snapshot, use this conditional before validation:

```ts
let positions = await this.client.positions();
if ([...this.positions.values()].some(local => !positions.some(remote => remote.symbol === local.symbol && Number(remote.size) > 0))) {
  this.handleExecutions(await this.client.executions(startTime));
  positions = await this.client.positions();
}
```

- [x] Leave existing kill reasons, synchronized=false during all requests, deduplication, POST behavior and risk guards intact. Add the Russian explanation `Локальная позиция не найдена на бирже; закрытие не подтверждено` for `local position missing on exchange`.
- [x] Freeze recognition of known native protective order IDs for the fetched orders snapshot before confirmation fills remove the local position. Regression: sibling TP/SL present in the first orders response still finishes synchronized after the real close; genuine unknown or non-reduce-only orders still block.
- [x] Run the targeted tests; task files will be committed together after independent review.

## Task 2: Telegram command menu

Files: `src/telegram/commands.ts`, `src/telegram/TelegramBot.ts`, `tests/telegram/menu.test.ts`.

- [x] Write tests for command registration in the configured chat, Russian descriptions for all eight supported commands, commands menu button, registration failure preserving polling, disabled bot making no requests, and historical commands not being replayed. Capture method/body in the fake fetcher; return an empty array for getUpdates and abort its long poll on stop.
- [x] Run `node node_modules/vitest/vitest.mjs run tests/telegram/menu.test.ts`; confirm it fails before adding registration.
- [x] Export command descriptions using a `Record<Command, string>` and derive menu entries from `commands` to avoid a second list.
- [x] At startup, call:

```ts
await this.request('setMyCommands', {
  scope: { type: 'chat', chat_id: this.chatId },
  commands: commands.map(command => ({ command, description: commandDescriptions[command] })),
});
await this.request('setChatMenuButton', {
  chat_id: Number(this.chatId),
  menu_button: { type: 'commands' },
});
```

- [x] Catch registration failure without blocking normal getUpdates initialization/polling; log a sanitized warning. Only request a private chat menu button for a positive safe integer chat ID; command scope accepts string IDs. Discard historical updates before or independently of registration so a slow menu does not replay historical commands. Keep command handlers and their authorization unchanged. Test transport must recognize new methods without treating them as updates.
- [x] Run Telegram tests; task files will be committed together after independent review.

## Task 3: Review, verify and deliver

Files: `README.md`, approved spec and this plan; production archive under `.tools/deploy`.

- [x] Document extra GET confirmation, preserved manual latch for unresolved mismatch, and Telegram commands menu. Mark the spec approved by the user's `примени` and record the subsequent menu request.
- [x] Obtain independent spec and quality review of both tasks; resolve actionable findings and rerun affected checks.
- [x] Run all tests (132 passed), typecheck, lint, formatting check for changed TypeScript, and production build. Merge verified work locally into main without touching untracked server memory.
- [x] Package dist from the verified worktree with existing production node_modules, package.json and DEPLOY_COMMIT; do not include ENV or local SQLite.
- [x] Upload archive; stop trad-baybit gracefully; save consistent server SQLite backup and previous app directory. Replace only application directory, retain server ENV and risk state. Start service and verify startup account reconciliation, connections, menu registration, and current latch reasons.
- [x] Handle current incident latch only after direct account audit and fresh market checks, preserving any unrelated guards. Keep rollback files and verify the two sites and football bot health endpoint.

User authorization covers applying the approved reconciliation design and adding the existing Telegram commands to the menu. Current guard reset was explicitly authorized earlier; additional unexplained reasons require investigation before removal.

Verification: independent spec review approved; independent quality review identified a stale protection-order classification edge, fixed with three regressions and approved on re-review. Full suite: 132 tests passed; typecheck, lint, build, changed-file formatting and diff checks passed.

## Deployment evidence

Applied on 2026-10-03 from commit `73884ad08f0449cc3f2bacd21db064f6d689f7ab`.
The merged main checkout also passed all 132 tests; the temporary worktree was removed.
Server archive SHA-256: `9abaac772d4077a9aba28d95b09e84ae2fcb633d2179321dd14df3d2351865ab`.
Application rollback, consistent SQLite backup and retained environment copy:
`/var/backups/trad-baybit-confirmation-20261003T163631Z`.
A separate pre-reset SQLite backup is at
`/var/backups/trad-baybit-guard-reset-20261003T163952Z/demo.db`.

New code was first started with the existing latch preserved. Direct DEMO GETs
confirmed zero positions/orders before the authorized one-time incident reset;
all non-kill state was compared and preserved inside the reset transaction.
The inspected `market data stale` latch was manually cleared only after both
connections and complete account/market health had recovered for 30 seconds.
No blanket automatic recovery was added for market or other protection reasons.

After reset the service resumed signal/order processing and opened two DEMO
positions. A further 30-second observation found no new latch or connection loss;
brief `account state unsynchronized` statuses during scheduled reconciliation
resolved on the next sample. Final state was HEALTHY with `killSwitch.active=false`.
Telegram `getMyCommands` returned all eight Russian-described commands and
`getChatMenuButton` returned `commands`, verified again after the final restart.
A transient Telegram read timeout was retried successfully without sending messages.
Both existing sites returned HTTP 200 and the football bot health returned ok.
Server ENV, risk limits, daily PnL and cooldown records were retained.
