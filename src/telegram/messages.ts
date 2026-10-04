import type { Position, Signal, Trade, Side } from '../exchange/bybit/types.js';
import type { Mode } from '../config/env.js';
import type { Health } from '../monitoring/health.js';
import type { TradingEngine } from '../trading/TradingEngine.js';
import type { tradeStats } from '../monitoring/metrics.js';
import type { ProfitReport } from '../monitoring/profit.js';

const number = (v: number) =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 8 }).format(v);
const money = (v: number) => `${number(v)} USDT`;
const direction = (side: Side) =>
  side === 'Long' ? 'покупка — расчёт на рост' : 'продажа — расчёт на снижение';
export const strategyText = (name: 'scalping' | 'trend-pullback') =>
  name === 'trend-pullback' ? 'Тренд и откат 15м / 1ч' : 'Скальпинг 1м / 5м';
export function modeText(mode: Mode): string {
  return {
    signal: 'Только сигналы, без сделок',
    paper: 'Симуляция на компьютере',
    testnet: 'Тестовая биржа, виртуальные деньги',
    demo: 'DEMO Bybit, виртуальные деньги',
    live: 'Реальная торговля',
  }[mode];
}
const explanations: Record<string, string> = {
  trend: 'Общее движение цены поддерживает вход',
  ema: 'Краткосрочное движение цены поддерживает вход',
  vwap: 'Цена находится с нужной стороны средней цены дня',
  rsi: 'Темп изменения цены подходит для входа',
  volume: 'Объём торгов вырос',
  book: 'В заявках на бирже есть перевес в нужную сторону',
  spread: 'Разница между ценой покупки и продажи небольшая',
  'hourly trend': 'Часовой тренд поддерживает направление входа',
  'entry trend': 'Тренд на 15-минутном графике поддерживает вход',
  pullback: 'Цена вернулась к средней после отката',
  recovery: 'Закрытая свеча подтвердила возобновление движения',
  extension: 'Цена входа остаётся достаточно близко к средней',
  quote: 'Цена на бирже актуальна',
  volatility: 'Размер движения подходит для защитного стопа',
  costs: 'Планируемая цель покрывает комиссии и проскальзывание',
  'market data stale': 'Рыночные данные перестали обновляться вовремя',
  'market websocket disconnected too long': 'Связь с рыночными данными потеряна надолго',
  'private websocket disconnected too long': 'Связь с аккаунтом потеряна надолго',
  'public websocket disconnected': 'Нет связи с рыночными данными',
  'private websocket disconnected': 'Нет связи с аккаунтом',
  'database unavailable': 'Не удалось открыть журнал сделок',
  'database unavailable in critical operation': 'Не удалось записать важное событие в журнал',
  'REST connectivity stale': 'Биржа давно не отвечала на запросы',
  'account state unsynchronized': 'Данные аккаунта ещё проверяются',
  'daily loss limit': 'Достигнут дневной лимит убытка',
  'exchange error threshold exceeded': 'Биржа вернула слишком много ошибок подряд',
  'ambiguous order submission': 'Биржа не подтвердила, принят ли ордер',
  'ambiguous order cancellation': 'Биржа не подтвердила отмену ордера',
  'event processing backlog': 'Бот не успевает обрабатывать события',
  'critical engine operation failed': 'Ошибка при обработке торгового события',
  'state mismatch': 'Данные бота и биржи не совпадают',
  'local/exchange position mismatch': 'Размер позиции у бота и на бирже не совпадает',
  'local position missing on exchange':
    'Локальная позиция не найдена на бирже; закрытие не подтверждено',
  'unknown active exchange order': 'На бирже обнаружен неизвестный боту ордер',
  'unknown open exchange position': 'На бирже обнаружена неизвестная боту позиция',
  'exchange position has missing protection': 'У позиции на бирже нет нужных защитных уровней',
  'exchange protection differs from local state':
    'Защитные уровни на бирже отличаются от расчёта бота',
  'exchange leverage exceeds configured limit': 'Плечо на бирже превышает установленный лимит',
  'failed to update exchange protection': 'Не удалось обновить защитные уровни на бирже',
};
export function reasonText(reason: string): string {
  const market = /^([A-Z0-9]+USDT): market unsynchronized or stale$/.exec(reason);
  if (market) return `${market[1]}: данные ещё не готовы или давно не обновлялись`;
  const key = reason.replace(/ confirmed$/, '');
  return (
    explanations[key] ?? 'Обнаружена техническая проблема; подробности сохранены в журнале бота'
  );
}
export function formatSignal(s: Signal, mode: Mode, risk: number): string {
  return [
    `${s.side === 'Long' ? '🟢' : '🔴'} Сигнал: ${s.symbol}`,
    direction(s.side),
    `Режим: ${modeText(mode)}`,
    ...(s.strategy ? [`Стратегия: ${strategyText(s.strategy)}`] : []),
    `Оценка условий: ${s.score}/100 — это баллы, не вероятность прибыли`,
    `Планируемый вход: ${money(s.entry)}`,
    `Ограничение убытка: ${money(s.stopLoss)}`,
    `Цель прибыли: ${money(s.takeProfit)}`,
    `Расчётный риск: до ${number(risk)}% выделенного капитала с учётом расходов`,
    '',
    'Почему появился сигнал:',
    ...s.reasons.map((r) => `• ${reasonText(r)}`),
    '',
    mode === 'signal'
      ? 'Это сигнал. В этом режиме бот не выставляет ордера.'
      : 'Это сигнал, сделка ещё не подтверждена. Об исполнении ордера сообщу отдельно.',
  ].join('\n');
}
export function formatPosition(p: Position): string {
  return [
    `✅ Ордер исполнен: ${p.symbol}`,
    direction(p.side),
    `Режим: ${modeText(p.mode as Mode)}`,
    `Текущий размер позиции: ${number(p.quantity)}`,
    `Средняя цена входа: ${money(p.entry)}`,
    `Ограничение убытка: ${money(p.stopLoss)}`,
    `Цель прибыли: ${money(p.takeProfit)}`,
    p.mode === 'paper'
      ? 'Это симуляция на компьютере; на Bybit позиция не появится.'
      : 'Позицию можно увидеть на Bybit в разделе «Позиции» соответствующего режима.',
  ].join('\n');
}
export function formatTrade(t: Trade): string {
  const exit = {
    take_profit: 'достигнута цель прибыли',
    stop_loss: 'сработало ограничение убытка',
    manual: 'ручное закрытие',
    strategy_exit: 'выход по стратегии',
    daily_guard: 'дневной лимит убытка',
    shutdown: 'остановка бота',
  }[t.exitReason];
  return [
    `${t.netPnL >= 0 ? '✅' : '🔴'} Сделка закрыта: ${t.symbol}`,
    direction(t.side),
    `Режим: ${modeText(t.mode as Mode)}`,
    `Вход: ${money(t.entry)}; выход: ${money(t.exit)}`,
    `Результат после комиссий: ${t.netPnL > 0 ? '+' : ''}${money(t.netPnL)}`,
    `Комиссии: ${money(t.fees)}`,
    `Причина: ${exit}`,
  ].join('\n');
}
export function formatHealth(h: Health): string {
  const label = {
    HEALTHY: 'Работает нормально',
    DEGRADED: 'Есть проблемы со связью или данными',
    UNHEALTHY: 'Работа нарушена',
  }[h.status];
  return [label, ...h.reasons.map((r) => `• ${reasonText(r)}`)].join('\n');
}
export function formatStop(reasons: string[], mode: Mode): string {
  return [
    `⛔ Новые сделки остановлены`,
    `Режим: ${modeText(mode)}`,
    ...reasons.map((r) => `• ${reasonText(r)}`),
    'Сначала нужно устранить причину остановки.',
  ].join('\n');
}
export function formatStatus(s: ReturnType<TradingEngine['status']>): string {
  const active = s.killSwitch.active
    ? 'Защитная остановка'
    : s.paused
      ? 'Новые входы на паузе'
      : 'Бот ищет вход';
  return [
    `${active}`,
    `Режим: ${modeText(s.mode)}`,
    `Стратегия: ${strategyText(s.strategy)}`,
    `Состояние: ${formatHealth(s.health)}`,
    `Рыночные данные: ${s.connection.public ? 'подключены' : 'нет связи'}`,
    `Аккаунт: ${['signal', 'paper'].includes(s.mode) ? 'не используется для ордеров' : s.connection.private ? 'подключён' : 'нет связи'}`,
    `Пары: ${s.symbols.join(', ')}`,
    `Баланс аккаунта: ${money(s.balance)}`,
    `Капитал для расчёта сделок: ${money(s.tradingCapitalUSDT)}`,
    `Результат закрытых сделок сегодня (по UTC): ${money(s.dailyPnL)}`,
    `Остановки по убыткам: ${s.lossLimitsEnabled ? 'включены' : 'отключены'}`,
    `Открытых позиций: ${s.openPositions}`,
    `Ордеров, ожидающих исполнения: ${s.pendingSymbols.length}`,
    ...s.killSwitch.reasons.map((r) => `Причина остановки: ${reasonText(r)}`),
    s.lastSignal
      ? `Последний сигнал: ${s.lastSignal.symbol}, ${direction(s.lastSignal.side)}`
      : 'Сигнала для входа пока нет',
  ].join('\n');
}
export function formatPositions(positions: Position[]): string {
  if (!positions.length) return 'Открытых позиций у бота сейчас нет.';
  return positions
    .map((p) =>
      [
        `${p.symbol}: ${direction(p.side)}`,
        `Размер: ${number(p.quantity)}; вход: ${money(p.entry)}`,
        `Ограничение убытка: ${money(p.stopLoss)}; цель: ${money(p.takeProfit)}`,
      ].join('\n'),
    )
    .join('\n\n');
}
export function formatStats(s: ReturnType<typeof tradeStats>): string {
  return [
    `Завершённых сделок: ${s.totalTrades}`,
    `Прибыльных: ${s.wins}; убыточных: ${s.losses}`,
    `Доля прибыльных: ${number(s.winRate)}%`,
    `Результат после комиссий: ${money(s.netPnL)}`,
    `Комиссии: ${money(s.fees)}`,
    `Средний результат сделки: ${money(s.expectancy)}`,
  ].join('\n');
}

const profitNumber = (value: number, digits = 6, signed = true): string => {
  const rounded = Number(value.toFixed(digits));
  const magnitude = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(
    Math.abs(rounded),
  );
  return `${rounded < 0 ? '−' : signed && rounded > 0 ? '+' : ''}${magnitude}`;
};
const profitMoney = (value: number, signed = true) => `${profitNumber(value, 6, signed)} USDT`;
const unavailable = 'недоступен — данные ещё проверяются или устарели';

export function formatProfit(r: ProfitReport): string {
  const closed = r.allTime;
  return [
    '💰 Прибыль бота',
    modeText(r.mode),
    ...(r.activeStrategy
      ? [
          `Текущая стратегия: ${strategyText(r.activeStrategy.name)}`,
          `Результат этой стратегии: ${profitMoney(r.activeStrategy.totals.netPnL)}, закрыто ${r.activeStrategy.totals.totalTrades} сделок`,
        ]
      : []),
    '',
    'За всё время — завершённые сделки:',
    `Заработано на прибыльных: ${profitMoney(closed.winningPnL)}`,
    `Потеряно на убыточных: ${profitMoney(closed.losingPnL)}`,
    `Чистый итог: ${profitMoney(closed.netPnL)}`,
    `Комиссии: ${profitMoney(closed.fees, false)} — уже включены в итог`,
    `Закрыто сделок: ${closed.totalTrades}; прибыльных: ${closed.wins}, убыточных: ${closed.losses}, без прибыли и убытка: ${closed.breakEven}`,
    '',
    `Сегодня (UTC): ${profitMoney(r.today.netPnL)}, закрыто ${r.today.totalTrades} сделок`,
    '',
    `Открытых позиций${r.openPnL === null ? ' в журнале' : ''}: ${r.openPositions}`,
    `Их текущий результат: ${r.openPnL === null ? unavailable : profitMoney(r.openPnL)}`,
    `Общий результат сейчас: ${r.totalPnL === null ? unavailable : profitMoney(r.totalPnL)}`,
    ...(r.initialCapital === null
      ? []
      : [
          '',
          `Исходный капитал бота: ${profitMoney(r.initialCapital, false)}`,
          `Расчётный капитал сейчас: ${r.currentCapital === null ? unavailable : profitMoney(r.currentCapital, false)}`,
          `Изменение: ${r.returnPercent === null ? 'нет актуальных данных' : `${profitNumber(r.returnPercent, 4)}%`}`,
          'Капитал рассчитан по выделенной сумме и результатам бота.',
        ]),
    ...(r.openPositions === 0
      ? []
      : [
          '',
          'Результат открытых позиций меняется с ценой.',
          'Учтены списанные комиссии; комиссия будущего закрытия не включена.',
        ]),
  ].join('\n');
}
