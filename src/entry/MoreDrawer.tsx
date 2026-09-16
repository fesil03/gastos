import { useEffect, useState } from 'react'
import type { Taxonomy } from '../db/hooks'
import { ensureTag, lastFxRate } from '../db/mutations'

export interface Extras {
  note: string
  tags: number[]
  currency: string
  fxRate: number | null // null → use last known
  income: boolean
  customDate: string | null // 'YYYY-MM-DDTHH:mm' from datetime-local, or null = auto
}

export const EMPTY_EXTRAS = (refCurrency: string): Extras => ({
  note: '',
  tags: [],
  currency: refCurrency,
  fxRate: null,
  income: false,
  customDate: null,
})

const CURRENCIES = ['CNY', 'BRL', 'USD', 'EUR']

interface Props {
  extras: Extras
  onChange: (next: Extras) => void
  taxonomy: Taxonomy
  refCurrency: string
}

/** Everything that is *not* on the critical path: note, tags, currency, date, income. (No payment method — spec §2.) */
export function MoreDrawer({ extras, onChange, taxonomy, refCurrency }: Props) {
  const [newTag, setNewTag] = useState('')
  const set = (patch: Partial<Extras>) => onChange({ ...extras, ...patch })

  useEffect(() => {
    if (extras.currency !== refCurrency && extras.fxRate == null) {
      lastFxRate(extras.currency).then((r) => r && set({ fxRate: r }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extras.currency])

  return (
    <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/50 p-3 text-sm" data-testid="more-drawer">
      <input
        value={extras.note}
        onChange={(e) => set({ note: e.target.value })}
        placeholder="Nota (opcional) — ex. Abacaxi, 1.47kg, 25.60元/kg"
        data-testid="note-input"
        className="w-full rounded-xl bg-slate-800 px-3 py-2 outline-none placeholder:text-slate-500"
      />

      <div className="flex flex-wrap gap-1.5">
        {taxonomy.tags.map((t) => {
          const on = extras.tags.includes(t.id!)
          return (
            <button
              key={t.id}
              data-testid="tag-chip"
              onClick={() => set({ tags: on ? extras.tags.filter((x) => x !== t.id) : [...extras.tags, t.id!] })}
              className={`rounded-full px-2.5 py-1 text-xs ${on ? 'bg-amber-500 text-slate-950' : 'bg-slate-800 text-slate-300'}`}
            >
              #{t.name}
            </button>
          )
        })}
        <form
          className="flex"
          onSubmit={async (e) => {
            e.preventDefault()
            if (!newTag.trim()) return
            const id = await ensureTag(newTag)
            set({ tags: extras.tags.includes(id) ? extras.tags : [...extras.tags, id] })
            setNewTag('')
          }}
        >
          <input
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            placeholder="+ tag"
            className="w-20 rounded-full bg-slate-800/60 px-2.5 py-1 text-xs outline-none placeholder:text-slate-500"
          />
        </form>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex overflow-hidden rounded-xl bg-slate-800">
          {CURRENCIES.map((c) => (
            <button
              key={c}
              data-testid={`currency-${c}`}
              onClick={() => set({ currency: c, fxRate: c === refCurrency ? 1 : null })}
              className={`px-2.5 py-1.5 text-xs ${extras.currency === c ? 'bg-slate-600 font-semibold' : 'text-slate-400'}`}
            >
              {c}
            </button>
          ))}
        </div>
        {extras.currency !== refCurrency && (
          <label className="flex items-center gap-1 text-xs text-slate-400">
            1 {extras.currency} =
            <input
              type="number"
              inputMode="decimal"
              step="0.0001"
              data-testid="fx-input"
              value={extras.fxRate ?? ''}
              onChange={(e) => set({ fxRate: e.target.value ? Number(e.target.value) : null })}
              className="w-20 rounded-lg bg-slate-800 px-2 py-1 text-right text-slate-100 outline-none"
            />
            {refCurrency}
          </label>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <input
          type="datetime-local"
          data-testid="date-input"
          value={extras.customDate ?? ''}
          onChange={(e) => set({ customDate: e.target.value || null })}
          className="rounded-lg bg-slate-800 px-2 py-1 text-xs text-slate-200 outline-none"
        />
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <input type="checkbox" checked={extras.income} onChange={(e) => set({ income: e.target.checked })} data-testid="income-toggle" />
          Receita (+)
        </label>
      </div>
    </div>
  )
}
