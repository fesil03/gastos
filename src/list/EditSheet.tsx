import { useState } from 'react'
import type { Taxonomy } from '../db/hooks'
import { deleteTransaction, ensureTag, updateTransaction } from '../db/mutations'
import type { Transaction } from '../db/types'
import { CategoryPicker } from '../entry/CategoryPicker'
import { keypadToMinor, minorToKeypad } from '../lib/money'
import { Sheet } from '../ui/Sheet'

const CURRENCIES = ['CNY', 'BRL', 'USD', 'EUR']

interface Props {
  tx: Transaction
  taxonomy: Taxonomy
  refCurrency: string
  onClose: () => void
  onDeleted: (tx: Transaction) => void
}

export function EditSheet({ tx, taxonomy, refCurrency, onClose, onDeleted }: Props) {
  const [amount, setAmount] = useState(minorToKeypad(tx.amountMinor).replace('.', ','))
  const [income, setIncome] = useState(tx.amountMinor > 0)
  const [currency, setCurrency] = useState(tx.currency)
  const [fxRate, setFxRate] = useState(String(tx.fxRate))
  const [date, setDate] = useState(tx.date.slice(0, 16))
  const [categoryId, setCategoryId] = useState(tx.categoryId)
  const [tags, setTags] = useState<number[]>(tx.tags)
  const [note, setNote] = useState(tx.note ?? '')
  const [picker, setPicker] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [newTag, setNewTag] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const cat = taxonomy.categoryById.get(categoryId)
  const group = cat && taxonomy.groupById.get(cat.groupId)

  async function save() {
    const minor = keypadToMinor(amount.replace(',', '.'))
    if (minor == null || minor === 0) return setErr('Valor inválido')
    const rate = currency === refCurrency ? 1 : Number(fxRate)
    if (!Number.isFinite(rate) || rate <= 0) return setErr('Taxa inválida')
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(date)) return setErr('Data inválida')
    await updateTransaction(tx.id!, {
      amountMinor: income ? minor : -minor,
      currency,
      fxRate: rate,
      date: date.length === 16 ? `${date}:00` : date,
      categoryId,
      tags,
      note: note.trim() || undefined,
    })
    onClose()
  }

  return (
    <Sheet title="Editar lançamento" onClose={onClose} testId="edit-sheet">
      <div className="space-y-3 text-sm">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIncome((v) => !v)}
            className={`h-11 w-11 shrink-0 rounded-xl text-xl font-semibold ${income ? 'bg-lime-500/20 text-lime-300' : 'bg-slate-800 text-slate-300'}`}
            data-testid="edit-sign"
          >
            {income ? '+' : '−'}
          </button>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))}
            data-testid="edit-amount"
            className="h-11 min-w-0 flex-1 rounded-xl bg-slate-800 px-3 text-right text-2xl tabular-nums outline-none"
          />
          <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="h-11 rounded-xl bg-slate-800 px-2 outline-none" data-testid="edit-currency">
            {CURRENCIES.concat(CURRENCIES.includes(tx.currency) ? [] : [tx.currency]).map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        {currency !== refCurrency && (
          <label className="flex items-center gap-2 text-xs text-slate-400">
            1 {currency} =
            <input type="number" step="0.0001" value={fxRate} onChange={(e) => setFxRate(e.target.value)} className="w-24 rounded-lg bg-slate-800 px-2 py-1 text-right text-slate-100 outline-none" />
            {refCurrency}
          </label>
        )}

        <button
          type="button"
          onClick={() => setPicker(true)}
          data-testid="edit-category"
          className="flex w-full items-center gap-2 rounded-xl bg-slate-800 px-3 py-2.5 text-left"
        >
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: group?.color ?? '#94a3b8' }} />
          <span className="flex-1">
            {cat?.name ?? '—'}
            {cat?.isTopUp === 1 && <span className="ml-1.5 rounded bg-slate-700 px-1 py-0.5 text-[10px] uppercase tracking-wide text-slate-300">top-up</span>}
          </span>
          <span className="text-xs text-slate-500">{group?.name}</span>
        </button>

        <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} data-testid="edit-date" className="w-full rounded-xl bg-slate-800 px-3 py-2 outline-none" />

        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Nota" data-testid="edit-note" className="w-full rounded-xl bg-slate-800 px-3 py-2 outline-none placeholder:text-slate-500" />

        <div className="flex flex-wrap gap-1.5">
          {taxonomy.tags.map((t) => {
            const on = tags.includes(t.id!)
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTags(on ? tags.filter((x) => x !== t.id) : [...tags, t.id!])}
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
              setTags((x) => (x.includes(id) ? x : [...x, id]))
              setNewTag('')
            }}
          >
            <input value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder="+ tag" className="w-20 rounded-full bg-slate-800/60 px-2.5 py-1 text-xs outline-none placeholder:text-slate-500" />
          </form>
        </div>

        {tx.source === 'wallet-import' && <p className="text-[11px] text-slate-600">Importado do Wallet · {tx.createdAt.slice(0, 10)}</p>}
        {err && <p className="text-red-400">{err}</p>}

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            data-testid="edit-delete"
            onClick={async () => {
              if (!confirmDelete) return setConfirmDelete(true)
              const removed = await deleteTransaction(tx.id!)
              if (removed) onDeleted(removed)
              onClose()
            }}
            className={`rounded-xl px-4 py-2.5 text-sm font-medium ${confirmDelete ? 'bg-red-600 text-white' : 'bg-slate-800 text-red-400'}`}
          >
            {confirmDelete ? 'Confirmar exclusão' : 'Excluir'}
          </button>
          <div className="flex-1" />
          <button type="button" data-testid="edit-save" onClick={() => void save()} className="rounded-xl bg-amber-500 px-5 py-2.5 text-sm font-semibold text-slate-950">
            Salvar
          </button>
        </div>
      </div>

      {picker && (
        <CategoryPicker
          taxonomy={taxonomy}
          onClose={() => setPicker(false)}
          onPick={(id) => {
            setCategoryId(id)
            setPicker(false)
          }}
        />
      )}
    </Sheet>
  )
}
