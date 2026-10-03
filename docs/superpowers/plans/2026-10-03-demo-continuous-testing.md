# Demo Continuous Testing Implementation Plan

**Goal:** Отключить остановки по потерям в DEMO и восстановить разрешённое пользователем тестирование.

**Architecture:** Флаг `DEMO_CONTINUOUS_TESTING` валидируется в env и используется общей политикой `DailyLossGuard.lossLimitsEnabled`. RiskManager применяет серию потерь и cooldown только при включённых лимитах. Существующий kill latch очищается оператором только для подтверждённой причины дневного убытка.

**Tech Stack:** TypeScript, Zod, Vitest, SQLite, systemd.

- [x] Добавить тесты в `tests/risk/risk.test.ts` для DEMO с включённым флагом: большой дневной убыток, серия 60 потерь, cooldown, восстановление состояния, технические блокировки.
- [x] Добавить тесты в `tests/config/demo.test.ts`: default false, true разрешён только DEMO, статус отражает флаг.
- [x] Запустить `pnpm exec vitest run tests/risk/risk.test.ts tests/config/demo.test.ts`; подтвердить отказ новых тестов.
- [x] В `src/config/env.ts` добавить `DEMO_CONTINUOUS_TESTING: bool(false)` и отклонять true вне DEMO.
- [x] В `DailyLossGuard` добавить getter, возвращающий false только для DEMO с флагом. В blocked после проверки equity и initialize возвращать false при выключенных лимитах.
- [x] В `RiskManager` оградить проверки серии и cooldown условием `guard.lossLimitsEnabled`.
- [x] В `TradingEngine.status` добавить `lossLimitsEnabled`, в Telegram отобразить состояние лимитов. Обновить пример env и README.
- [x] Выполнить `pnpm test && pnpm typecheck && pnpm lint && pnpm build`, проверить форматирование и diff, запросить проверку кода.
- [x] Передать только изменённые dist-модули на сервер. При остановленной trad-baybit сохранить серверные модули, env и SQLite, проверить DEMO-аккаунт, включить флаг и снять только daily loss latch с audit event.
- [x] Запустить службу и подтвердить HEALTHY, private/public=true, lossLimitsEnabled=false, paused=false, killSwitch.active=false и повторную сверку аккаунта; сохранить результат в документации восстановления.
