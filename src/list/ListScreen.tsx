import { useCallback, useMemo, useState } from 'react'
import { useAllTransactions, useRefCurrency, useTaxonomy } from '../db/hooks'
import { restoreTransaction } from '../db/mutations'
import type { Transaction } from '../db/types'
import { CategoryPicker } from '../entry/CategoryPicker'
import { addMonths, dayKey, formatDay, formatMonth, formatTime, monthBounds, monthKey } from '../lib/dates'
import { formatMinor } from '../lib/money'
import { Toast, type ToastState } from '../ui/Toast'
import { EditSheet } from './EditSheet'
import { filterTransactions, groupByDay, isEmptyFilter, type TxFilter } from './filter'

type Period = 'month' | '30d' | '90d' | 'year' | 'all'
const PAGE = 150

export function ListScreen() {
  const txs = useAllTransactions()
  const taxonomy = useTaxonomy()
  const refCurrency = useRefCurrency()

  const [query, setQuery] = useState('')
  const [period, setPeriod] = useState<Period>('month')
  const [month, setMonth] = useState(() => monthKey(dayKey()))
  const [categoryIds, setCategoryIds] = useState<number[]>([])
  const [tagIds, setTagIds] = useState<number[]>([])
  const [picker, setPicker] = useState(false)
  const [editing, setEditing] = useState<Transaction | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const [toast, setToast] = useState<ToastState | null>(null)
  const dismissToast = useCallback((id: number) => setToast((t) => (t?.id === id ? null : t)), [])

  const filter: TxFilter = useMemo(() => {
    const f: TxFilter = { query, categoryIds, tagIds }
    const today = dayKey()
    if (period === 'month') [f.fromDay, f.toDay] = monthBounds(month)
    else if (period === '30d') f.fromDay = dayKey(new Date(), -30)
    else if (period === '90d') f.fromDay = dayKey(new Date(), -90)
    else if (period === 'year') f.fromDay = `${today.slice(0, 4)}-01-01`
    return f
  }, [query, categoryIds, tagIds, period, month])

  const filtered = useMemo(() => (txs ? filterTransactions(txs, filter, taxonomy.categoryById) : []), [txs, filter, taxonomy.categoryById])
  const days = useMemo(() => groupByDay(filtered), [filtered])
  const total = useMemo(() => filtered.reduce((s, t) => (t.refAmountMinor < 0 ? s + t.refAmountMinor : s), 0), [filtered])
  const income = useMemo(() => filtered.reduce((s, t) => (t.refAmountMinor > 0 ? s + t.refAmountMinor : s), 0), [filtered])

  // Paginate by rows, cutting at a day boundary.
  const visibleDays = useMemo(() => {
    const out: typeof days = []
    let n = 0
    for (const d of days) {
      if (n >= limit) break
      out.push(d)
      n += d.txs.length
    }
    return out
  }, [days, limit])
  const shown = visibleDays.reduce((s, d) => s + d.txs.length, 0)

  const activeCats = categoryIds.map((id) => taxonomy.categoryById.get(id)).filter(Boolean)

  return (
    <div className="flex h-full flex-col" data-testid="list-screen">
      <div className="sticky top-0 z-10 space-y-2 bg-slate-950/95 px-4 pb-2 pt-4 backdrop-blur">
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setLimit(PAGE)
          }}
          placeholder="Buscar nota, item ou categoria…"
          data-testid="list-search"
          className="w-full rounded-xl bg-slate-900 px-3 py-2.5 text-sm outline-none placeholder:text-slate-500"
        />
        <div className="flex items-center gap-1.5 overflow-x-auto text-xs [scrollbar-width:none]">
          {period === 'month' && (
            <div className="flex shrink-0 items-center overflow-hidden rounded-full bg-slate-900">
              <button className="px-2.5 py-1.5 text-slate-400" onClick={() => setMonth((m) => addMonths(m, -1))} data-testid="month-prev">
                ‹
              </button>
              <span className="min-w-14 text-center font-medium" data-testid="month-label">
                {formatMonth(month)}
              </span>
              <button className="px-2.5 py-1.5 text-slate-400" onClick={() => setMonth((m) => addMonths(m, 1))} data-testid="month-next">
                ›
              </button>
            </div>
          )}
          {(
            [
              ['month', 'mês'],
              ['30d', '30d'],
              ['90d', '90d'],
              ['year', 'ano'],
              ['all', 'tudo'],
            ] as [Period, string][]
          ).map(([p, label]) => (
            <button
              key={p}
              data-testid={`period-${p}`}
              onClick={() => {
                setPeriod(p)
                setLimit(PAGE)
              }}
              className={`shrink-0 rounded-full px-2.5 py-1.5 ${period === p ? 'bg-slate-700 text-slate-100' : 'bg-slate-900 text-slate-400'}`}
            >
              {label}
            </button>
          ))}
          <button
            data-testid="filter-category"
            onClick={() => setPicker(true)}
            className={`shrink-0 rounded-full px-2.5 py-1.5 ${categoryIds.length ? 'bg-amber-500 text-slate-950' : 'bg-slate-900 text-slate-400'}`}
          >
            {activeCats.length ? activeCats.map((c) => c!.name).join(', ') : 'categoria'}
          </button>
          {taxonomy.tags.map((t) => {
            const on = tagIds.includes(t.id!)
            return (
              <button
                key={t.id}
                onClick={() => setTagIds(on ? tagIds.filter((x) => x !== t.id) : [...tagIds, t.id!])}
                className={`shrink-0 rounded-full px-2.5 py-1.5 ${on ? 'bg-amber-500 text-slate-950' : 'bg-slate-900 text-slate-500'}`}
              >
                #{t.name}
              </button>
            )
          })}
          {(categoryIds.length > 0 || tagIds.length > 0 || query) && (
            <button
              data-testid="filter-clear"
              onClick={() => {
                setCategoryIds([])
                setTagIds([])
                setQuery('')
              }}
              className="shrink-0 rounded-full px-2.5 py-1.5 text-slate-400 underline"
            >
              limpar
            </button>
          )}
        </div>
        <p className="flex justify-between text-xs text-slate-500">
          <span data-testid="list-count">
            {filtered.length} {filtered.length === 1 ? 'lançamento' : 'lançamentos'}
          </span>
          <span className="tabular-nums">
            {income > 0 && <span className="text-lime-400">+{formatMinor(income, refCurrency, { sign: false })} · </span>}
            <span className="text-slate-300" data-testid="list-total">
              {formatMinor(-total, refCurrency, { sign: false })}
            </span>
          </span>
        </p>
      </div>

      <div className="flex-1 px-4 pb-6">
        {txs && filtered.length === 0 && (
          <p className="py-10 text-center text-sm text-slate-500">{isEmptyFilter(filter) ? 'Nenhum lançamento ainda.' : 'Nada encontrado nesse filtro.'}</p>
        )}
        {visibleDays.map((d) => (
          <section key={d.day} className="mb-4" data-testid="day-group">
            <header className="mb-1 flex items-baseline justify-between text-xs">
              <span className="font-medium text-slate-300">{formatDay(d.day)}</span>
              <span className="tabular-nums text-slate-500">{formatMinor(d.totalRefMinor, refCurrency)}</span>
            </header>
            <ul className="divide-y divide-slate-900 overflow-hidden rounded-2xl bg-slate-900/50">
              {d.txs.map((t) => {
                const cat = taxonomy.categoryById.get(t.categoryId)
                const group = cat && taxonomy.groupById.get(cat.groupId)
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      data-testid="tx-row"
                      onClick={() => setEditing(t)}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left active:bg-slate-800"
                      style={{ boxShadow: `inset 3px 0 0 ${group?.color ?? '#94a3b8'}` }}
                    >
                      <span className="w-10 shrink-0 text-xs tabular-nums text-slate-500">{formatTime(t.date)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">
                          {cat?.name ?? '—'}
                          {cat?.isTopUp === 1 && <span className="ml-1.5 rounded bg-slate-800 px-1 py-0.5 text-[9px] uppercase tracking-wide text-slate-400">top-up</span>}
                        </span>
                        {(t.note || t.tags.length > 0) && (
                          <span className="block truncate text-xs text-slate-500">
                            {t.note}
                            {t.tags.map((id) => (
                              <span key={id} className="ml-1 text-amber-500/80">
                                #{taxonomy.tagById.get(id)?.name}
                              </span>
                            ))}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-right">
                        <span className={`block text-sm tabular-nums ${t.amountMinor > 0 ? 'text-lime-400' : ''}`}>{formatMinor(t.amountMinor, t.currency)}</span>
                        {t.currency !== refCurrency && <span className="block text-[10px] tabular-nums text-slate-500">{formatMinor(t.refAmountMinor, refCurrency)}</span>}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
        {shown < filtered.length && (
          <button onClick={() => setLimit((l) => l + PAGE)} data-testid="load-more" className="w-full rounded-xl bg-slate-900 py-2.5 text-xs text-slate-400">
            mostrar mais ({filtered.length - shown} restantes)
          </button>
        )}
      </div>

      {picker && (
        <CategoryPicker
          taxonomy={taxonomy}
          title="Filtrar por categoria"
          onClose={() => setPicker(false)}
          onPick={(id) => {
            setCategoryIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))
            setPicker(false)
            setLimit(PAGE)
          }}
        />
      )}
      {editing && (
        <EditSheet
          tx={editing}
          taxonomy={taxonomy}
          refCurrency={refCurrency}
          onClose={() => setEditing(null)}
          onDeleted={(removed) =>
            setToast({
              id: removed.id!,
              message: `Excluído · ${formatMinor(removed.amountMinor, removed.currency)}`,
              actionLabel: 'Desfazer',
              onAction: () => void restoreTransaction(removed),
            })
          }
        />
      )}
      <Toast toast={toast} onDismiss={dismissToast} />
    </div>
  )
}
