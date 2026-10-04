# План исправления повторной остановки DEMO

Цель: восстановление после доказанно устранённого временного сбоя.
Стек: TypeScript, Vitest, SQLite, systemd.

- [x] Воспроизвести отсутствие восстановления в `tests/risk/demo-recovery.test.ts`:
  `pnpm exec vitest run tests/risk/demo-recovery.test.ts` — 14 failures,
  отсутствует recoverDemo.
- [x] Добавить в KillSwitch ограниченный recoverDemo, атомарный аудит и
  ожидание стабильного здоровья; вызвать из очереди health timer bootstrap.
- [x] Проверить новые тесты, всю существующую suite, typecheck, lint, build,
  Prettier и diff check. Проверить границы восстановления и сбой транзакции.
- [x] Провести проверку кода и устранить значимые замечания.
- [x] Создать серверный backup SQLite; сохранить прежние bootstrap/KillSwitch
  и maps. Остановить только trad-baybit, атомарно заменить проверенные модули,
  запустить службу. Не менять env и не копировать локальную БД.
- [x] Проверить автоматическое снятие latch, HEALTHY, успешные сверки и новый
  принятый вход; записать результат в recovery report.
