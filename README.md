# Bybit V5 scalping bot

Рабочий TypeScript MVP для исследований скальпинга USDT perpetual: закрытые свечи 1m/5m,
стакан, публичные сделки, объяснимые сигналы, отдельный контроль риска и журнал SQLite.
Начальный режим **SIGNAL на BYBIT TESTNET**. SIGNAL и PAPER не вызывают торговые API.
Стратегия и стартовые параметры не гарантируют прибыль.

## Установка и конфигурация

Рекомендуется **Node.js 24 LTS**, pnpm 11.19+. Совместимость проверяется также на Node 22.23.
SQLite поставляется с Node; отдельный сервер и нативная npm-сборка SQLite не нужны.
Node может выводить предупреждение об экспериментальном `node:sqlite`.

```bash
nvm use
corepack enable
pnpm install
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

Создайте `.env` из `.env.example`, если файла ещё нет. **В этом workspace `.env` уже есть:
не перезаписывайте его; перенесите нужные настройки вручную.** Старые настройки Alpaca/SPY
не используются новым ботом. В `.env.example` перечислены все поддерживаемые параметры.
Zod проверяет значения; ошибки выводят имена параметров, не секреты.

Для первого запуска достаточно:

```dotenv
TRADING_MODE=signal
ENABLE_LIVE_TRADING=false
MARKET_DATA_NETWORK=testnet
SYMBOLS=BTCUSDT,ETHUSDT
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
BYBIT_API_KEY=
BYBIT_API_SECRET=
```

Без Telegram бот работает с журналом, логами и HTTP API. Для уведомлений заполните
**оба** `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID`. Токен получите у BotFather, chat ID
возьмите из Telegram Bot API после отправки боту `/start`. Не публикуйте секреты.
Для SIGNAL/PAPER ключи Bybit не нужны. При пустом chat ID и заполненном token
приложение намеренно откажется запускаться.

## Безопасная последовательность запуска

```bash
pnpm check:market                 # публичные Testnet REST/WS, без .env и ключей
pnpm signal                      # только сигналы; trading API заблокированы
pnpm check:telegram               # getMe/getChat; не отправляет сообщений
pnpm check:telegram --send        # явно запрошенное тестовое сообщение
pnpm paper                       # виртуальные ордера на реальных WS-данных
```

Для проверки без существующего `.env`:

```bash
pnpm signal --no-env --run-seconds 30
pnpm paper --no-env --run-seconds 30
```

`--no-env` отключает чтение файла, но не переменные оболочки. Команды signal/paper/testnet
явно устанавливают свой режим и имеют приоритет над `TRADING_MODE` из `.env`.
`pnpm dev` также принудительно запускает SIGNAL. `pnpm start` использует `.env`/ENV.

`check:market` за 20 секунд проверяет REST metadata, историю, WS subscribe ACK и все
темы для обоих инструментов. Результат должен содержать `connected: true`,
`ready: true` и ненулевые счётчики `kline.1`, `kline.5`, `orderbook.50`, `publicTrade`.
На малоликвидном Testnet некоторые потоки могут не дать событие за 20 секунд;
диагностика явно покажет отсутствующий поток. Ордеров эта команда не отправляет.
Время стакана переводится из часов биржи в локальное через синхронизацию REST;
малые погрешности оценки времени не вызывают ложную остановку. Задержанные данные
по-прежнему считаются устаревшими; явно неверные timestamps вызывают переподключение.
После закрытия очередной свечи даётся `CANDLE_STALE_MS` на доставку подтверждения;
само наступление 5-минутной границы не вызывает аварийную остановку.

Для более репрезентативного PAPER можно **явно** выбрать публичный mainnet:
`MARKET_DATA_NETWORK=mainnet`. Это не включает биржевое исполнение.
`pnpm check:market --network mainnet` проверяет только публичные mainnet-потоки.
В TESTNET выбор public network игнорируется: все endpoints остаются Testnet.

## Bybit Demo Trading в обычном аккаунте

Режим **DEMO** выставляет ордера в демо-среде Bybit; их можно видеть в разделе
Demo Trading своего обычного аккаунта. Используются виртуальные средства. PAPER
хранит виртуальные ордера только локально. Testnet — отдельная среда и сайт.

По [официальной инструкции Bybit](https://bybit-exchange.github.io/docs/v5/demo):
войдите в обычный аккаунт на Bybit, переключитесь на **Demo Trading**, затем через
меню профиля откройте **API** и создайте системный HMAC API Key/Secret именно внутри
Demo Trading. Для USDT perpetual нужны разрешения на ордера и позиции; не включайте
Withdraw. Ключ от обычного торгового аккаунта и ключ Testnet сюда не подходят.
Убедитесь, что демо-баланс пополнен виртуальными USDT, включены unified cross margin
и one-way position mode. В свежем демо-аккаунте не создавайте ручные позиции/ордера
на инструментах бота: неизвестная экспозиция блокирует автоматические входы.

Файл `.env.demo.example` содержит безопасные настройки. Создайте из него `.env.demo`,
если этого файла ещё нет; в данном workspace уже подготовлен отдельный пустой файл.
Внесите ключ и secret только в него, не отправляйте их в чат. Старый `.env` сохраняется.
Оставьте `TRADING_MODE=demo`, `ENABLE_LIVE_TRADING=false`, `DATABASE_PATH=data/demo.db`.
DEMO использует отдельный журнал; PAPER kill latch не сбрасывается и не переносится.
В Demo Trading Bybit сохраняет историю ордеров семь дней; локальный журнал остаётся.

Сначала остановите PAPER через Ctrl+C и проверьте доступ **без отправки ордеров**:

```bash
pnpm check:demo
```

Затем запустите автоматическую демо-торговлю:

```bash
pnpm demo
```

Если `pnpm` недоступен в терминале этого Mac, используйте установленный Node напрямую:

```bash
cd /Users/amiran/Downloads/spy-signal-bot
~/.local/bin/node --env-file=.env.demo --import tsx scripts/check-demo.ts
~/.local/bin/node --env-file=.env.demo --import tsx src/index.ts --mode demo --no-env
```

Node `--env-file` загружает выбранный файл; `--no-env` у бота предотвращает загрузку
старого `.env`. Экспортированные переменные оболочки имеют приоритет над файлом.
При запуске ожидайте `BYBIT DEMO TRADING — VIRTUAL FUNDS ONLY`, подключение public/private
WS и `HEALTHY`. Проверяйте также `/api/status`: `mode` и `network` должны быть `demo`,
`connection.private: true`, `killSwitch.active: false`. Сигнал должен пройти все
стратегические и риск-фильтры; немедленные ордера не гарантируются.

DEMO подписывает запросы только к `https://api-demo.bybit.com`, private WS использует
`wss://stream-demo.bybit.com/v5/private`, а public REST/WS получает с mainnet.
Неверный ключ вызывает отказ без переключения на реальные деньги; флаг включения
LIVE в режиме DEMO запрещён. Команда проверки выполняет только GET, без POST и ордеров.
До заполнения локального ключа authenticated DEMO lifecycle остаётся непроверенным.

## Bybit TESTNET

Сначала выполните backtest и PAPER. Создайте отдельный ключ на
[Bybit Testnet](https://testnet.bybit.com/), пополните тестовый unified account и
настройте **cross margin, one-way position mode**, USDT linear perpetual.
Classic accounts, hedge mode и portfolio/isolated margin пока не поддерживаются.

В `.env` заполните `BYBIT_API_KEY` и `BYBIT_API_SECRET` **тестовыми** значениями.
Затем:

```bash
pnpm testnet
```

До первого ордера бот выводит `BYBIT TESTNET MODE`, проверяет API key/account,
баланс, metadata, leverage, активные ордера, позиции, историю fills, публичный и
авторизованный private WS. Входы возможны только при `HEALTHY`.
Настройка leverage выполняется только для инструмента без открытой позиции.
Неизвестная позиция или ордер на account блокируют новые входы и вызывают alert.
API REST и private WS строго привязаны к testnet.

## Архитектура

```text
src/
  app/             bootstrap, блокировка второго процесса, shutdown
  config/          Zod ENV и неизменяемые endpoint mappings
  exchange/bybit/  V5 REST, public/private WS, metadata, account adapter
  market/          свечи, snapshot/delta стакана, сделки, синхронизация
  indicators/      EMA, Wilder RSI/ATR, UTC-session VWAP, volume SMA
  strategy/        ScalpingStrategy, SignalScore, SignalEngine
  risk/            PositionSizer, RiskManager, DailyLossGuard, KillSwitch
  trading/         TradingEngine, PositionLedger, PAPER/TESTNET/DEMO/LIVE execution
  database/        SQLite WAL, транзакции и журнал
  telegram/        команды, форматирование и уведомления
  monitoring/      health и статистика после расходов
  api/             отдельный read-only HTTP API
  backtest/        загрузка истории, исторический replay и CLI
  utils/           decimal normalization, retry только reads, sanitizing logger
scripts/           market/Telegram/demo diagnostics, operator kill-latch reset
fixtures/          явно синтетические данные для offline smoke-test
tests/            unit/regression/integration tests с изолированными transport doubles
```

Exchange adapter изолирован от стратегии. Стратегия вызывается один раз для новой
закрытой 1m свечи. Фильтр использует только уже закрытые 5m свечи. VWAP сбрасывается
по UTC, volume SMA не включает проверяемую свечу. Snapshot каждого кандидата содержит
EMA9/21/50, RSI, ATR, VWAP, объёмы, spread, imbalance, тренд 5m, score и причины.

Семь конфигурируемых весов дают **эвристический score 0–100, не вероятность**.
Trend, EMA structure, spread, ATR, минимальные подтверждения и RR проверяются
дополнительно. `LOG_LEVEL=debug` показывает, почему каждый кандидат отклонён.
Новые символы добавляются через `SYMBOLS`; metadata загружается из V5 API.

## Исполнение, риск и состояние

- Риск по умолчанию 0.25% equity; объём зависит от расстояния до ATR stop, комиссий,
  slippage и округления; target, не покрывающий расходы, отклоняется. Объём ограничивается margin, qty step/max/min и min notional.
  Leverage по умолчанию 1, жёсткий максимум MVP 3. Leverage не умножает риск-бюджет.
- Stop/TP нормализуются по metadata; RR проверяется после округления. При гэпе или
  недостаточной ликвидности фактический убыток может превышать рассчитанный бюджет.
- Default entry: `Limit` + `PostOnly`. Через 20 секунд неисполненный остаток отменяется.
  Автоматического превращения в Market нет. `ENTRY_ORDER_TYPE=Market` — явный выбор.
- Биржевой intent сохраняется **до POST**; UUID используется как `orderLinkId`.
  POST не повторяется после timeout. Проверяются realtime/history по тому же ID;
  неизвестный исход остаётся зарезервированным и включает kill switch.
- Fills учитываются по уникальному `execId`, partial fills — отдельно. Выходной fill,
  остаток позиции, прогресс reduce-only order и завершённая trade пишутся атомарно.
  При старте выполняется REST reconciliation; дневной PnL/streak восстанавливаются
  из durable trade journal, в том числе после сбоя между записью trade и guard.
- Native exchange SL/TP прикрепляются к entry. Breakeven включён, trailing выключен.
  При паузе или kill switch управление синхронизированными позициями продолжается.
- Reconnect блокирует входы до candle backfill и нового book snapshot. Стакан обновляется
  вставкой/заменой/удалением уровней; `u=1` сбрасывает его. Регрессии, malformed/crossed
  book или потеря соединения вызывают полный reconnect/resync. Bybit не обещает
  contiguous `seq`: произвольные положительные скачки не считаются потерей пакетов.
- Daily loss — больший из убытка закрытых сделок и снижения equity относительно UTC daily baseline.
  Ограничения streak/cooldown и pending/open capacity проверяются отдельно.
  При смене суток baseline обновляется; streak сам по календарю не обнуляется.
- `TRADING_CAPITAL_USDT` (необязательный) ограничивает выделенный капитал для расчёта
  риска и маржи. Уже занятая маржа вычитается из этой суммы; дневной лимит считается
  от выделенного капитала на начало дня. Размер следующих сделок учитывает результат
  собственных закрытых сделок, комиссии и текущую стоимость открытых позиций бота.
  Убыток в этой части контролируется отдельно от других активов DEMO-аккаунта;
  дополнительно действует дневной лимит снижения полного equity аккаунта, рассчитанный
  от полного начального equity. Это ограничение размера сделок, а не отдельный
  кошелёк. Баланс аккаунта в статусе остаётся фактическим.
- HTTP не позволяет управлять режимом. Секреты/URL с token/auth headers/signatures
  не выводятся. SQLite сохраняет signals/orders/fills/positions/trades/events и risk state.
- Один journal может использовать только один процесс. При аварийном завершении `.lock`
  остаётся. Удаляйте его **только после проверки, что прежний процесс остановлен**.

PAPER исполняет Market по bid/ask с adverse slippage и округлением. Limit требует
последующей публичной сделки через цену лимита, учитывает направление aggressor,
размер сделки, частичные fills и timeout; касание цены не считается гарантированным fill.
Stops исполняются по доступной худшей цене при гэпе. Gross PnL, fees, estimatedSlippage
и net PnL записываются отдельно; slippage уже заложен в fill price, второй раз не вычитается.

## Kill switch и остановка

Для непрерывного тестирования стратегий в DEMO задайте
`DEMO_CONTINUOUS_TESTING=true`. Дневной лимит убытка, предел серии убыточных
сделок и пауза после убытка перестают запрещать новые входы. PnL и история
продолжают учитываться; размеры сделок, ограничения параллельных позиций,
ручная пауза и технические проверки сохраняются. `/status` показывает
«Остановки по убыткам: отключены». По умолчанию флаг false; включение запрещено
в SIGNAL/PAPER/TESTNET/LIVE. Уже сохранённый kill latch снимается оператором
после проверки причины; остальные причины остановки автоматически не сбрасываются.

Причины: daily loss, stale market, длительный private disconnect, exchange error threshold,
неопределённая/расходящаяся позиция, неизвестный order, неоднозначный POST, критическая
ошибка SQLite или слишком большой event backlog. Входы немедленно запрещаются;
pending entry orders отменяются; причина сохраняется и отправляется в Telegram, если настроен.

Если локальная позиция исчезла из первого REST-снимка биржи, появилась ещё не
учтённая позиция или расходятся размер, сторона либо средняя цена, бот перед защитной
остановкой один раз повторно читает исполнения и позиции. Подтверждённый вход или
выход учитывается по реальному исполнению и позволяет продолжить работу без ложной
блокировки. Принадлежность защитных ордеров проверяется после этой сверки; известные
SL/TP закрывшейся позиции сохраняют свою классификацию из первого снимка ордеров.
Пока идёт сверка, новые входы запрещены. Неподтверждённое исчезновение
и другие расхождения по-прежнему включают защиту; ранее сохранённые причины остановки
и лимиты риска автоматически не сбрасываются.

В непрерывном DEMO (`DEMO_CONTINUOUS_TESTING=true`), если после повторного GET
исполнение известного ордера ещё не учтено, сверка возвращается в очередь с
`account state unsynchronized` и запретом новых входов. Это позволяет обработать
ожидающие события private WS и подтвердить состояние следующей сверкой. Ожидание
допускается для позиции с единственным известным ордером того же направления и
размером в пределах его резерва, недостающих исполнений известного ордера или
исчезновения локальной позиции. SL/TP, плечо, one-way mode и неизвестные ордера
продолжают проверяться; чужая позиция без подходящего ордера включает защиту сразу.
Срок подтверждения — 30 секунд, его начало хранится в SQLite и не обновляется при
рестарте. Если при следующей сверке срок истёк и расхождение осталось, включается
kill switch с исходной причиной. Учёт ведётся только по реальным исполнениям.
Успешная сверка очищает состояние ожидания, сохраняя уже включённые kill-причины.
Обычный DEMO, TESTNET и LIVE сохраняют прежнюю политику немедленной остановки
после дополнительного GET. События `account.reconcile.pending` и
`account.reconcile.confirmed` отмечают ожидание и подтверждение в журнале.

Окно истории исполнений определяется открытыми позициями и конкретными
незавершёнными ордерами, включая reduce-only закрытия и недостающие исполнения.
Старые завершённые ордера по тому же символу не расширяют окно нового входа.
Если сама открытая позиция или незавершённый ордер старше шести дней, сохраняется
защитная остановка с требованием ручной проверки истории.

Kill switch сохраняется между запусками. `/resume` его не сбрасывает. После исправления
причины остановите бот, проверьте биржевой account и журнал, затем выполните:

```bash
pnpm guards:reset --confirm
```

Сбрасывается только kill latch; статистика потерь, настройки лимитов и проверки
account сохраняются. Daily loss и streak/cooldown действуют согласно выбранной
политике `DEMO_CONTINUOUS_TESTING`.
Устранённую причину обязательно проверяет следующий startup reconciliation.

При SIGINT/SIGTERM блокируются входы, подтверждается отмена entry orders, сохраняется
state, закрываются WS, HTTP и SQLite. По умолчанию `AUTO_CLOSE_ON_SHUTDOWN=false`:
открытая позиция не закрывается и сохраняет native exchange SL/TP. В PAPER позиция
сохраняется, но симуляция останавливается вместе с процессом. Если auto-close явно включён,
используются только reduce-only Market ордера; перед расчётом закрытия сверяются fills.
Неизвестный исход закрытия фиксируется для последующей сверки, не повторяется вслепую.

## Telegram и HTTP

Разрешены только команды из указанного `TELEGRAM_CHAT_ID`:
`/status`, `/positions`, `/stats`, `/profit`, `/pause`, `/resume`, `/mode`, `/health`.

При запуске бот регистрирует эти команды с русскими описаниями в меню разрешённого
чата. В личном чате нажмите «Меню» рядом с полем сообщения или введите `/` и выберите
команду. Ошибка регистрации меню не останавливает обычное получение команд.

`/profit` показывает, сколько заработали на прибыльных завершённых сделках и потеряли
на убыточных, чистый итог за всё время и сегодня по UTC, комиссии и количество сделок.
Суммы прибыли и убытка уже учитывают комиссии; строка комиссий справочная, повторно
их вычитать не нужно. В отчёт входят все завершённые сделки текущего режима из журнала.
Текущий результат открытых позиций оценивается по bid для Long и ask для Short, включает
частичные закрытия и уже списанные комиссии. Комиссия будущего закрытия не включена.
При устаревшей котировке, потере рыночного соединения или проверке состояния аккаунта
текущая оценка обозначается как недоступная; результат завершённых сделок сохраняется.
Если задан `TRADING_CAPITAL_USDT`, отчёт показывает начальный и расчётный капитал бота
и изменение в процентах. В расчёт входят результаты собственных сделок, отдельно от
других средств аккаунта. DEMO/PAPER/TESTNET отмечаются как виртуальные режимы.
Исторические команды старого процесса не проигрываются заново. `/pause` сразу запрещает
новые входы и запускает отмену pending entry orders; `/resume` требует HEALTHY и неактивный kill switch. `/mode` только показывает режим.
Ответы и уведомления написаны по-русски простыми словами. `/status` показывает
режим, связь, выделенный капитал, позиции и результат закрытых сделок за сутки UTC;
`/positions` — текущие позиции, `/stats` — итог завершённых сделок после комиссий.
Сигнал описывает план входа; исполнение ордера подтверждается отдельным сообщением
с фактическим размером и средней ценой позиции, закрытие — сообщением о результате.
При частичном исполнении приходят обновления размера. Защитная остановка объясняет
причину. Уведомления не задерживают trading loop; ошибки Telegram не раскрывают token.

API по умолчанию: `http://127.0.0.1:3000`:

```text
GET /api/status
GET /api/health
GET /api/signals
GET /api/trades
GET /api/positions
GET /api/stats
GET /api/profit
```

```bash
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/status
```

Ответы health содержат `HEALTHY/DEGRADED/UNHEALTHY` и причины. Signals/trades возвращают
последние 200 записей текущего режима. DB/PAPER/risk/exposure разделяются по mode.
Для доступа извне сначала добавьте аутентифицированный reverse proxy; API намеренно
разрешает только loopback и не содержит routes для создания ордеров.

## Backtest

Выбор стратегии: `STRATEGY=scalping` (прежний вариант 1м/5м, по умолчанию)
или `STRATEGY=trend-pullback` (вход после отката на 15м по часовому тренду).
Новый вариант проверяет EMA21/EMA50 и наклон часовой EMA, возврат цены к EMA21
за четыре предыдущие свечи и закрытие текущей свечи за экстремумом предыдущей.
RSI, спред, свежесть данных и волатильность остаются обязательными фильтрами.
Используются только закрытые непрерывные свечи; часовой бар должен соответствовать
моменту входа. На 15м границе часа бот ждёт часовой WS-бар или запрашивает его REST.

У новой стратегии стоп находится за экстремумом отката, минимум на 1,5 ATR,
цель равна 2,5 размера стопа. После комиссий и проскальзывания отношение дохода
к риску должно быть не ниже 1,5; размер стопа — не менее трёх суммарных расходов.
Эти условия повторно проверяются после округления цен к шагу инструмента.
Безубыток включается после 1,5R, trailing выключен. Политика защиты записывается
в сигнал: старые позиции продолжают использовать прежние настройки.

`/status` показывает выбранную стратегию, `/profit` — её отдельный результат
закрытых сделок вместе с общей историей. Непомеченные старые сделки относятся
к скальпингу. Смена стратегии не обнуляет капитал, историю и PnL.

Для прогона новой стратегии можно добавить `--strategy trend-pullback` к команде
backtest. Сравнение фиксированных вариантов на имеющейся шестипарной истории:
`node --import tsx scripts/compare-strategies.ts`. Скрипт не загружает `.env` и
не отправляет биржевые запросы; создаёт `backtest-results/strategy-comparison.json`
и `.md`. Контрольные последние два дня не используются для подбора параметров.
Первый прогон не подтвердил прибыльность новой стратегии; подробности в
[отчёте](docs/research/2026-10-04-strategy-comparison.md).

```bash
pnpm backtest
```

Без аргументов выполняется **синтетический offline smoke-test** на fixture, а не оценка
реального рынка. Обе части стартуют с независимым equity, positions и risk state;
для validation предыдущие свечи используются только для прогрева индикаторов.
Автоматической оптимизации нет. Убыточный demo-результат не является оценкой реальной стратегии.

Загрузка реальной закрытой истории через публичный API, без ключей и ордеров:

```bash
pnpm history --symbol BTCUSDT --days 7 --network testnet --out data/btc-1m.json
pnpm backtest --file data/btc-1m.json --split 0.7 --out backtest-results/btc.json
pnpm backtest --file data/btc-1m.json --order-type Market
```

Для mainnet истории укажите `--network mainnet` явно. Downloader сохраняет рядом
`data/btc-1m.json.instruments.json`; цены и quantity не хардкодятся для реальной торговли.
Для другого файла metadata можно передать `--instruments path.json`.
Вместо доли доступен `--validation-start 2026-01-02T00:00:00Z`.
JSON input — массив закрытых 1m candles в порядке времени:
`symbol, interval:1, start:<Unix ms>, open, high, low, close, volume, turnover, confirmed:true`.
Повторы, некорректный OHLC и неупорядоченные данные отклоняются; гэпы блокируют входы
до нового непрерывного прогрева. Для нескольких символов сортируйте массив глобально по start.

Сохраняются trades, equity curve, signals count и assumptions; статистика включает total trades,
wins/losses, win rate, gross/fees/net PnL, profit factor, average win/loss, expectancy,
max drawdown (также по equity с незакрытыми позициями). `profitFactor=null` означает
отсутствие убыточных сделок и неопределённое отношение.

Сигнал исполняется на следующем баре. Portfolio replay идёт по общей хронологии:
opens → entries → adverse extremes → favorable extremes → closes → signals.
При касании SL и TP внутри одной свечи выбирается неблагоприятный исход.
OHLC не содержит historical orderbook: imbalance нейтрален, book points не начисляются.
При limit timeout короче 60 секунд fill учитывается только при open trade-through;
положение low/high внутри первых 20 секунд не выдумывается.
Maker/taker fees, synthetic spread и adverse slippage конфигурируются. Funding, queue
priority, ликвидность и исторические изменения metadata пока не моделируются.

## LIVE TRADING

**Не запускался при разработке. Не включайте до backtest → PAPER → TESTNET.**

Для mainnet исполнения одновременно обязательны:

```dotenv
TRADING_MODE=live
ENABLE_LIVE_TRADING=true
```

Оба флага проверяются Zod/config, конструктором LIVE engine и непосредственно REST write
adapter. Ключи mainnet нужны отдельно. Без второго флага приложение откажется запускаться.
Запуск через `pnpm start` потребует заранее собранный проект. Никакая Telegram-команда,
public mainnet настройка или TESTNET command не включает LIVE.

Используйте отдельный API key для бота, **не давайте Withdraw permission**, используйте
IP whitelist, если доступен. Проверка key permissions дополнительно отклоняет Withdraw.
Не используйте общий account с ручными/другими ботами: неизвестные exposures блокируются.
`.env`, SQLite, logs, node_modules, tool cache и отчёты исключены из git.

## Проверка и практические ограничения

```bash
pnpm test
pnpm test:watch
pnpm typecheck
pnpm lint
pnpm build
```

Тесты проверяют индикаторы, score, normalization, guards, live gates, WS auth/ACK,
REST signing, SQLite rollback/dedup, PAPER partial fills/costs/gaps, ambiguous order timeout,
atomic exit accounting, cancellation acknowledgement, pause/kill management, Telegram authorization,
backtest chronology и training/validation replay.

Это реализованный MVP с защитными механизмами, **не аттестованная production-система**.
Нужны длительные PAPER/Testnet прогоны и проверка authenticated account/order lifecycle
на вашем аккаунте, включая Demo Trading: credentials не использовались при разработке. Реальную прибыльность,
latency, ликвидность и fills нельзя подтвердить unit tests или synthetic fixture.
Нет multi-process HA/failover, funding accounting, исторического L2 replay и margin-mode
миграций. Reconciliation истории старше шести дней требует ручного аудита.
Консервативная сверка snapshot/stream при биржевых гонках может потребовать operator reset;
при неопределённости входы блокируются. Уведомления Telegram best-effort и без durable outbox.
Для торговли необходим внешний мониторинг процесса, резервное копирование SQLite и
account-specific acceptance checks.

Актуальная интеграция сверена с официальными источниками:
[Bybit V5 authentication](https://bybit-exchange.github.io/docs/v5/guide),
[WebSocket connect](https://bybit-exchange.github.io/docs/v5/ws/connect),
[Orderbook snapshot/delta](https://bybit-exchange.github.io/docs/v5/websocket/public/orderbook),
[Create order](https://bybit-exchange.github.io/docs/v5/order/create-order),
[Instruments info](https://bybit-exchange.github.io/docs/v5/market/instrument),
[Private executions](https://bybit-exchange.github.io/docs/v5/websocket/private/execution),
[Native trading stop](https://bybit-exchange.github.io/docs/v5/position/trading-stop),
[Node releases](https://nodejs.org/en/about/previous-releases).
