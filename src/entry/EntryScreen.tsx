import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAllTransactions, useRefCurrency, useTaxonomy } from '../db/hooks'
import { addTransaction, deleteTransaction, restoreTransaction } from '../db/mutations'
import type { Transaction } from '../db/types'
import { dayKey, formatTime, nowIso, toLocalIso } from '../lib/dates'
import { formatKeypad, formatMinor, keypadToMinor } from '../lib/money'
import { Toast, type ToastState } from '../ui/Toast'
import { CategoryChip } from './CategoryChip'
import { CategoryPicker } from './CategoryPicker'
import { Keypad } from './Keypad'
import { EMPTY_EXTRAS, MoreDrawer, type Extras } from './MoreDrawer'
import { rankCategories } from './ranking'

type DateMode = 'today' | 'yesterday'

/**
 * The 5-second path: keypad is live on mount → type amount → tap a chip → saved, keypad cleared,
 * undo toast. Everything else lives behind "mais".
 */
export function EntryScreen() {
  const txs = useAllTransactions()
  const taxonomy = useTaxonomy()
  const refCurrency = useRefCurrency()

  const [amount, setAmount] = useState('')
  const [dateMode, setDateMode] = useState<DateMode>('today')
  const [selectedCat, setSelectedCat] = useState<number | null>(null)
  const [more, setMore] = useState(false)
  const [extras, setExtras] = useState<Extras>(() => EMPTY_EXTRAS(refCurrency))
  const [picker, setPicker] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [saving, setSaving] = useState(false)

  // Keep extras' currency in sync with settings until the user touches them.
  useEffect(() => {
    setExtras((x) => (x.note || x.tags.length || x.customDate ? x : EMPTY_EXTRAS(refCurrency)))
  }, [refCurrency])

  const ranked = useMemo(() => (txs ? rankCategories(txs, { limit: 8 }) : []), [txs])
  const amountMinor = keypadToMinor(amount)
  const dismissToast = useCallback((id: number) => setToast((t) => (t?.id === id ? null : t)), [])

  const resolveDate = (): string => {
    if (extras.customDate) return extras.customDate.length === 16 ? extras.customDate + ':00' : extras.customDate
    if (dateMode === 'yesterday') {
      const now = new Date()
      return toLocalIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, now.getHours(), now.getMinutes(), now.getSeconds()))
    }
    return nowIso()
  }

  const reset = () => {
    setAmount('')
    setSelectedCat(null)
    setDateMode('today')
    setExtras(EMPTY_EXTRAS(refCurrency))
    setMore(false)
  }

  const save = async (categoryId: number, minorOverride?: number, currencyOverride?: string) => {
    const minor = minorOverride ?? amountMinor
    if (minor == null || minor === 0 || saving) return
    setSaving(true)
    try {
      const signed = extras.income ? Math.abs(minor) : -Math.abs(minor)
      const currency = currencyOverride ?? extras.currency
      const id = await addTransaction({
        amountMinor: signed,
        currency,
        fxRate: currency === refCurrency ? 1 : (extras.fxRate ?? undefined),
        date: resolveDate(),
        categoryId,
        tags: extras.tags,
        note: extras.note.trim() || undefined,
      })
      const cat = taxonomy.categoryById.get(categoryId)
      let undone = false
      setToast({
        id,
        message: `${formatMinor(signed, currency)} · ${cat?.name ?? ''}${dateMode === 'yesterday' ? ' · ontem' : ''}`,
        actionLabel: 'Desfazer',
        onAction: async () => {
          if (undone) return
          undone = true
          const removed = await deleteTransaction(id)
          if (removed) setToast({ id: -id, message: 'Desfeito', actionLabel: 'Refazer', onAction: () => restoreTransaction(removed) })
        },
      })
      reset()
    } finally {
      setSaving(false)
    }
  }

  const onChipTap = (categoryId: number) => {
    if (amountMinor && amountMinor > 0) void save(categoryId)
    else setSelectedCat((c) => (c === categoryId ? null : categoryId))
  }

  const onChipLongPress = (categoryId: number) => {
    const r = ranked.find((x) => x.categoryId === categoryId)
    const last = r?.lastAmountMinor ?? (txs ?? []).filter((t) => t.categoryId === categoryId).sort((a, b) => b.date.localeCompare(a.date))[0]?.amountMinor
    if (last == null) return
    void save(categoryId, Math.abs(last), r?.lastCurrency)
  }

  const submitSelected = () => selectedCat != null && void save(selectedCat)

  const chips = ranked.map((r) => taxonomy.categoryById.get(r.categoryId)).filter(Boolean)
  const selectedName = selectedCat != null ? taxonomy.categoryById.get(selectedCat)?.name : null
  const showSave = selectedCat != null && amountMinor != null && amountMinor > 0

  return (
    <div className="flex h-full flex-col" data-testid="entry-screen">
      {/* Amount display */}
      <div className="flex-1 px-5 pt-5">
        <div className="flex items-baseline justify-between">
          <button
            type="button"
            data-testid="date-toggle"
            onClick={() => setDateMode((m) => (m === 'today' ? 'yesterday' : 'today'))}
            className={`rounded-full px-3 py-1 text-xs font-medium ${dateMode === 'yesterday' ? 'bg-amber-500 text-slate-950' : 'bg-slate-800 text-slate-300'}`}
          >
            {extras.customDate ? extras.customDate.slice(0, 16).replace('T', ' ') : dateMode === 'today' ? 'Hoje' : 'Ontem'}
          </button>
          <button
            type="button"
            data-testid="more-toggle"
            onClick={() => setMore((m) => !m)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${more ? 'bg-slate-700 text-slate-100' : 'bg-slate-800 text-slate-300'}`}
          >
            {more ? 'menos' : 'mais…'}
          </button>
        </div>

        <div className="mt-4 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-baseline gap-1">
              <span className="text-2xl text-slate-500">{extras.income ? '+' : '−'}</span>
              <span className="text-xs text-slate-500">{extras.currency}</span>
              <span data-testid="amount-display" className="truncate text-5xl font-semibold tabular-nums tracking-tight">
                {formatKeypad(amount)}
              </span>
            </div>
            <p className="mt-1 h-5 truncate text-sm text-slate-400">
              {selectedName ?? (amountMinor ? 'toque numa categoria para salvar' : ' ')}
              {extras.note && <span className="text-slate-500"> · {extras.note}</span>}
            </p>
          </div>
          {showSave && (
            <button
              type="button"
              data-testid="save-button"
              onClick={submitSelected}
              disabled={saving}
              className="shrink-0 rounded-2xl bg-amber-500 px-5 py-3 text-base font-semibold text-slate-950 active:scale-95 disabled:opacity-50"
            >
              Salvar
            </button>
          )}
        </div>

        {more && (
          <div className="mt-3">
            <MoreDrawer extras={extras} onChange={setExtras} taxonomy={taxonomy} refCurrency={refCurrency} />
          </div>
        )}

        {!more && txs && <TodaySoFar txs={txs} refCurrency={refCurrency} taxonomy={taxonomy} />}
      </div>

      {/* Chips + keypad, pinned to the bottom for one-handed reach */}
      <div className="px-3 pb-2">
        <div className="mb-2 grid grid-cols-4 gap-2" data-testid="chips">
          {chips.map((c) => {
            const r = ranked.find((x) => x.categoryId === c!.id)
            return (
              <CategoryChip
                key={c!.id}
                category={c!}
                group={taxonomy.groupById.get(c!.groupId)}
                selected={selectedCat === c!.id}
                hint={r?.lastAmountMinor != null ? formatMinor(Math.abs(r.lastAmountMinor), r.lastCurrency ?? refCurrency, { sign: false }) : undefined}
                onTap={() => onChipTap(c!.id!)}
                onLongPress={() => onChipLongPress(c!.id!)}
              />
            )
          })}
          {chips.length < 8 &&
            Array.from({ length: 8 - chips.length }).map((_, i) => <div key={`empty-${i}`} className="h-16 rounded-2xl border border-dashed border-slate-800" />)}
        </div>
        <button
          type="button"
          data-testid="all-categories"
          onClick={() => setPicker(true)}
          className="mb-2 w-full rounded-xl bg-slate-900/60 py-2 text-xs text-slate-400"
        >
          {selectedName && !chips.some((c) => c!.id === selectedCat) ? `Categoria: ${selectedName} · trocar` : 'todas as categorias…'}
        </button>
        <Keypad value={amount} onChange={setAmount} onSubmit={submitSelected} disabled={saving} />
      </div>

      {picker && (
        <CategoryPicker
          taxonomy={taxonomy}
          onClose={() => setPicker(false)}
          onPick={(id) => {
            setPicker(false)
            onChipTap(id)
          }}
        />
      )}
      <Toast toast={toast} onDismiss={dismissToast} />
    </div>
  )
}

/** Small feedback strip: what's been logged today, most recent first. */
function TodaySoFar({ txs, refCurrency, taxonomy }: { txs: Transaction[]; refCurrency: string; taxonomy: ReturnType<typeof useTaxonomy> }) {
  const today = dayKey()
  const todays = useMemo(
    () => txs.filter((t) => t.date.startsWith(today) && t.amountMinor < 0).sort((a, b) => b.date.localeCompare(a.date)),
    [txs, today],
  )
  if (!todays.length) return <p className="mt-6 text-xs text-slate-600">Nada lançado hoje ainda.</p>
  const total = todays.reduce((s, t) => s + t.refAmountMinor, 0)
  return (
    <div className="mt-6" data-testid="today-so-far">
      <p className="mb-1.5 text-xs text-slate-500">
        Hoje · {todays.length} {todays.length === 1 ? 'lançamento' : 'lançamentos'} · <span className="text-slate-300 tabular-nums">{formatMinor(-total, refCurrency, { sign: false })}</span>
      </p>
      <ul className="space-y-0.5 text-xs text-slate-400">
        {todays.slice(0, 4).map((t) => (
          <li key={t.id} className="flex justify-between gap-2">
            <span className="truncate">
              {formatTime(t.date)} · {taxonomy.categoryById.get(t.categoryId)?.name}
              {t.note ? <span className="text-slate-600"> · {t.note}</span> : null}
            </span>
            <span className="shrink-0 tabular-nums">{formatMinor(t.amountMinor, t.currency, { sign: false })}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
