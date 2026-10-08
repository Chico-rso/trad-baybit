# Delayed execution reconciliation

User approved fixing execution/position reconciliation on 2026-10-08 after the
proposed fix and deployment were explained. This approval covers code, regression
tests and updating the existing DEMO service, preserving its SQLite and ENV.

## Evidence and chosen approach

SUI on October 6 and HYPE on October 8 triggered `unknown open exchange position`
just before the queued execution updated the ledger (HYPE: 33 ms). Both executions
were subsequently accounted and positions closed, but their kill latch persisted.
The existing additional REST read does not let the serialized engine queue process
its waiting private-stream updates.

Keep the additional confirmation read. If an unresolved discrepancy is explained
by an existing durable entry intent, a missing known local position, or an order
fill deficit, return unsynchronized and allow the queue to process real executions.
Use a 30-second confirmation deadline persisted in SQLite so restart cannot renew
it. This phase is restricted to DEMO with `DEMO_CONTINUOUS_TESTING=true`;
TESTNET/LIVE and ordinary DEMO retain their existing immediate latch policy.
Reconcile on the existing periodic schedule; a successful reconciliation clears
only this pending confirmation state. Never clear kill reasons automatically.
When the deadline has elapsed, latch the original discrepancy reasons on the next
reconciliation. API/accounting failures retain their immediate protection.

Only a unique outstanding owned entry can explain an unaccounted remote entry:
same symbol/side, positive finite quantity within its reservation, no completed
trade for that entry, same signal as any partial local position. Validate one-way
mode, configured leverage, finite positive price, and expected native SL/TP even
while the execution is pending. Unknown orders and positions with no such intent
remain immediately blocked after the existing confirmation. Native SL/TP for the
pending owned remote position can retain ownership until its fill is processed.
Retain this validated ownership across queued private SL/TP updates, including
protection IDs not present in the REST snapshot; expire it at the same persisted
deadline and require the durable entry to remain pending and without a closed trade.
Partial fills can temporarily explain quantity/average-price differences; an
unexplained side or quantity change cannot.

Repeated GET-only retries would still monopolize the queue and cannot guarantee
stream progress. Expanding automatic kill reset would obscure genuine unknown
exposure. The bounded unsynchronized phase permits confirmation without either.

## Verification and delivery

Reproduce delayed owned entry after both REST reads, delayed partial entry, delayed
close, fill deficit with matching positions, duplicate fills and restoration.
Assert entries remain blocked during confirmation, deadline survives restart,
expired discrepancies latch, real unknown positions/orders and invalid protection
still latch, errors propagate, and unrelated kill state is preserved. Verify clean
snapshots require no extra GET and pending state clears after confirmation.

Run targeted and full Vitest, typecheck, ESLint, formatting, build and diff checks;
obtain independent code review. Back up server dist and the server-owned SQLite,
update only compiled code, restart DEMO and verify fresh account reconciliation,
public/private streams, retained history and continuous testing. Roll back dist
on failed verification. Telegram network repair is outside this change.
