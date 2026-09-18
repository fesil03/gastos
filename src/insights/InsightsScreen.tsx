import { useMemo, useState } from 'react'
import { useAllTransactions, useBalanceChecks, useRefCurrency, useTaxonomy, useUntrackedPeriods } from '../db/hooks'
import { addMonths, dayKey, formatMonth, monthBounds, monthKey } from '../lib/dates'
import { formatMinor } from '../lib/money'
import { BalancePanel } from './BalancePanel'
import { Donut, Heatmap, MonthlyColumns, RankedBars, StatTile, compact } from './charts'
import { CoveragePanel } from './CoveragePanel'
import {
  categoryBreakdown,
  categoryDrift,
  groupBreakdown,
  hourWeekdayHeatmap,
  inRange,
  monthlyStats,
  rollingDailyAverage,
  smallTicketLeakage,
  streak,
  suspectedIncomplete,
  ticketStats,
} from './engine'

type Period = 'month' | 'last' | '3m' | '12m' | 'all'

export function InsightsScreen() {
  const txs = useAllTransactions()
  const taxonomy = useTaxonomy()
  const currency = useRefCurrency()
  const untracked = useUntrackedPeriods() ?? []
  const checks = useBalanceChecks() ?? []
  const topUpIds = taxonomy.topUpIds
  const [period, setPeriod] = useState<Period>('12m')
  const [heatMode, setHeatMode] = useState<'count' | 'total'>('count')

  const today = dayKey()
  const thisMonth = monthKey(today)

  const range = useMemo((): [string, string] => {
    if (period === 'month') return monthBounds(thisMonth)
    if (period === 'last') return monthBounds(addMonths(thisMonth, -1))
    if (period === '3m') return [monthBounds(addMonths(thisMonth, -2))[0], today]
    if (period === '12m') return [monthBounds(addMonths(thisMonth, -11))[0], today]
    return ['0000-01-01', '9999-12-31']
  }, [period, thisMonth, today])

  const all = txs ?? []
  const stats = useMemo(() => monthlyStats(all, { untracked }), [all, untracked])
  const scoped = useMemo(() => inRange(all, range[0], range[1]), [all, range])
  const groups = useMemo(() => groupBreakdown(scoped, taxonomy.categoryById), [scoped, taxonomy.categoryById])
  const cats = useMemo(() => categoryBreakdown(scoped), [scoped])
  // Top-ups stay in the totals above but leave the ticket-size / time-of-day analyses (spec §3).
  const heat = useMemo(() => hourWeekdayHeatmap(scoped, topUpIds), [scoped, topUpIds])
  const leak = useMemo(() => smallTicketLeakage(scoped, undefined, topUpIds), [scoped, topUpIds])
  const ticket = useMemo(() => ticketStats(scoped, topUpIds), [scoped, topUpIds])
  const strk = useMemo(() => streak(all, today), [all, today])
  const suspects = useMemo(() => suspectedIncomplete(stats), [stats])
  const avg = (days: number) => {
    const v = rollingDailyAverage(all, days, today, untracked)
    return v == null ? '—' : compact(v, currency)
  }

  // Drift compares the latest month that has data against its trailing complete months.
  const driftMonth = useMemo(() => {
    const withData = stats.filter((m) => m.count > 0)
    return withData.length ? withData[withData.length - 1].month : thisMonth
  }, [stats, thisMonth])
  const drift = useMemo(() => categoryDrift(all, driftMonth, stats).slice(0, 6), [all, driftMonth, stats])

  const monthPoints = useMemo(() => {
    const inScope = stats.filter((m) => `${m.month}-01` <= range[1] && monthBounds(m.month)[1] >= range[0])
    const slice = period === 'all' ? inScope : inScope.slice(-12)
    return slice.map((m) => ({
      month: m.month,
      label: slice.length > 13 || m.month.endsWith('-01') ? formatMonth(m.month) : formatMonth(m.month).split(' ')[0],
      valueMinor: m.totalMinor,
      count: m.count,
      incomplete: m.incomplete,
      untracked: m.coverage === 'untracked',
    }))
  }, [stats, range, period])

  const total = scoped.reduce((s, t) => (t.refAmountMinor < 0 ? s - t.refAmountMinor : s), 0)
  const expenseCount = scoped.filter((t) => t.refAmountMinor < 0).length
  const leakTotal = leak.reduce((s, m) => s + m.smallTotalMinor, 0)
  const leakCount = leak.reduce((s, m) => s + m.smallCount, 0)
  const incompleteMonths = stats.filter((m) => m.incomplete && m.count > 0).length
  const untrackedMonths = stats.filter((m) => m.coverage === 'untracked').length

  if (!txs) return null
  if (!all.length) return <p className="p-6 text-sm text-slate-500">Sem dados ainda. Importe o Wallet ou lance alguns gastos.</p>

  return (
    <div className="space-y-5 px-4 pb-8 pt-4" data-testid="insights-screen">
      <div className="flex items-center gap-1.5 overflow-x-auto text-xs [scrollbar-width:none]">
        {(
          [
            ['month', 'este mês'],
            ['last', 'mês passado'],
            ['3m', '3 meses'],
            ['12m', '12 meses'],
            ['all', 'tudo'],
          ] as [Period, string][]
        ).map(([p, label]) => (
          <button key={p} data-testid={`ins-period-${p}`} onClick={() => setPeriod(p)} className={`shrink-0 rounded-full px-2.5 py-1.5 ${period === p ? 'bg-slate-700 text-slate-100' : 'bg-slate-900 text-slate-400'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* Hero */}
      <div>
        <p className="text-xs text-slate-500">gasto no período · {expenseCount} lançamentos</p>
        <p className="text-4xl font-semibold tabular-nums tracking-tight" data-testid="ins-total">
          {formatMinor(total, currency, { sign: false })}
        </p>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <StatTile label="média/dia · 7d" value={avg(7)} testId="avg-7" />
        <StatTile label="média/dia · 30d" value={avg(30)} testId="avg-30" />
        <StatTile label="média/dia · 90d" value={avg(90)} testId="avg-90" />
      </div>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Por mês</h2>
        <MonthlyColumns points={monthPoints} currency={currency} />
        {period === 'all' && (incompleteMonths > 0 || untrackedMonths > 0) && (
          <p className="mt-1 text-[11px] text-slate-500">
            {incompleteMonths > 0 && `${incompleteMonths} ${incompleteMonths === 1 ? 'mês' : 'meses'} com poucos lançamentos (<40% da mediana) marcados como incompletos.`}
            {incompleteMonths > 0 && untrackedMonths > 0 && ' '}
            {untrackedMonths > 0 && `${untrackedMonths} ${untrackedMonths === 1 ? 'mês' : 'meses'} sem registro por decisão — lacunas, não zeros.`}
          </p>
        )}
      </section>

      <CoveragePanel suspects={suspects} untracked={untracked} currentMonth={thisMonth} />

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Por grupo</h2>
        <Donut
          currency={currency}
          totalLabel="total"
          slices={groups.map((g) => {
            const grp = taxonomy.groupById.get(g.id)
            return { id: g.id, label: grp?.name ?? 'Outros', color: grp?.color ?? '#64748b', valueMinor: g.totalMinor, share: g.share }
          })}
        />
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Por categoria</h2>
        <RankedBars
          currency={currency}
          rows={cats.map((c) => {
            const cat = taxonomy.categoryById.get(c.id)
            const grp = cat && taxonomy.groupById.get(cat.groupId)
            return { id: c.id, label: cat ? (cat.isTopUp === 1 ? `${cat.name} · top-up` : cat.name) : '—', color: grp?.color ?? '#64748b', valueMinor: c.totalMinor, share: c.share, count: c.count }
          })}
        />
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Hora × dia
            {(heat.excludedTopUps > 0 || heat.excludedUnknownTime > 0) && (
              <span className="ml-1 font-normal normal-case tracking-normal text-slate-600" data-testid="heat-excluded">
                ·{heat.excludedTopUps > 0 && ' sem top-ups'}
                {heat.excludedTopUps > 0 && heat.excludedUnknownTime > 0 && ' ·'}
                {heat.excludedUnknownTime > 0 && ` ${heat.excludedUnknownTime} sem hora`}
              </span>
            )}
          </h2>
          <div className="flex overflow-hidden rounded-full bg-slate-900 text-[11px]">
            <button onClick={() => setHeatMode('count')} className={`px-2.5 py-1 ${heatMode === 'count' ? 'bg-slate-700 text-slate-100' : 'text-slate-400'}`}>
              lançamentos
            </button>
            <button onClick={() => setHeatMode('total')} className={`px-2.5 py-1 ${heatMode === 'total' ? 'bg-slate-700 text-slate-100' : 'text-slate-400'}`}>
              gasto
            </button>
          </div>
        </div>
        <Heatmap count={heat.count} totalMinor={heat.totalMinor} currency={currency} mode={heatMode} />
      </section>

      <section className="grid grid-cols-2 gap-2">
        <StatTile
          label="miudezas (< ¥30)"
          value={formatMinor(leakTotal, currency, { sign: false })}
          sub={`${leakCount} lanç. · ${ticket.count ? Math.round((leakCount / ticket.count) * 100) : 0}% dos lanç. · ${total ? Math.round((leakTotal / total) * 100) : 0}% do gasto`}
          testId="leakage"
        />
        <StatTile
          label="ticket mediano"
          value={formatMinor(ticket.medianMinor, currency, { sign: false })}
          sub={`média ${compact(ticket.meanMinor, currency)}${ticket.excludedTopUps ? ` · ${ticket.excludedTopUps} top-ups fora` : ''}`}
          testId="ticket"
        />
        <StatTile
          label="sequência de dias"
          value={`${strk.current} ${strk.current === 1 ? 'dia' : 'dias'}`}
          sub={strk.current ? `recorde: ${strk.longest}` : strk.lastDay ? `último: ${strk.lastDay.slice(5).replace('-', '/')} · recorde ${strk.longest}` : undefined}
          testId="streak"
          className="col-span-2"
        />
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Mudanças · {formatMonth(driftMonth)} vs média 3 meses
        </h2>
        <ul className="space-y-1 text-xs" data-testid="drift">
          {drift.map((d) => {
            const cat = taxonomy.categoryById.get(d.categoryId)
            const up = d.deltaMinor > 0
            return (
              <li key={d.categoryId} className="flex items-center justify-between gap-2 rounded-xl bg-slate-900/60 px-3 py-2">
                <span className="min-w-0 truncate text-slate-300">{cat?.name ?? '—'}</span>
                <span className="shrink-0 tabular-nums text-slate-500">
                  {compact(d.baselineMinor, currency)} → <span className="text-slate-200">{compact(d.currentMinor, currency)}</span>
                </span>
                <span className={`w-16 shrink-0 text-right tabular-nums ${up ? 'text-rose-300' : 'text-emerald-300'}`}>
                  {up ? '▲' : '▼'} {compact(Math.abs(d.deltaMinor), currency)}
                </span>
              </li>
            )
          })}
        </ul>
      </section>

      <BalancePanel checks={checks} txs={all} currency={currency} />
    </div>
  )
}
