import { useState } from 'react'
import { addBalanceCheck, removeBalanceCheck } from '../db/mutations'
import { DEFAULT_ACCOUNT, type BalanceCheck, type Transaction } from '../db/types'
import { formatMonth, nowIso } from '../lib/dates'
import { formatMinor, keypadToMinor } from '../lib/money'
import { Sheet } from '../ui/Sheet'
import { captureRates } from './engine'

interface Props {
  checks: BalanceCheck[]
  txs: Transaction[]
  currency: string
}

/**
 * Spec §8.1 — one screen, one number. Enter the balance you actually have whenever you feel
 * like it; from two consecutive checks we report the share of spending you captured.
 * Never nags, never badges, never on the entry path. With zero or one check it stays quiet.
 */
export function BalancePanel({ checks, txs, currency }: Props) {
  const [open, setOpen] = useState(false)
  const windows = captureRates(checks, txs)
  const latest = windows[windows.length - 1]

  return (
    <section data-testid="balance-panel">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Conferência de saldo</h2>
        <button type="button" data-testid="balance-open" onClick={() => setOpen(true)} className="rounded-full bg-slate-900 px-2.5 py-1 text-[11px] text-slate-300">
          {checks.length ? 'ver / anotar' : 'anotar saldo'}
        </button>
      </div>

      {latest ? (
        <div className="rounded-2xl bg-slate-900/60 p-3" data-testid="capture-rate">
          {latest.status === 'ok' && latest.rate != null ? (
            <>
              <p className="text-2xl font-semibold tabular-nums">
                {Math.round(latest.rate * 100)}% <span className="text-sm font-normal text-slate-400">capturado</span>
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500">
                você registrou {formatMinor(latest.loggedSpendMinor, currency, { sign: false })} de {formatMinor(latest.impliedSpendMinor, currency, { sign: false })} gastos ·{' '}
                {windowLabel(latest.from.date, latest.to.date)}
              </p>
            </>
          ) : latest.status === 'unrecorded-income' ? (
            <>
              <p className="text-sm text-slate-200">Há receita não registrada nesse período.</p>
              <p className="mt-0.5 text-[11px] text-slate-500">
                O saldo caiu menos do que o gasto registrado ({formatMinor(latest.loggedSpendMinor, currency, { sign: false })}) explicaria · {windowLabel(latest.from.date, latest.to.date)}. Lance a receita
                para a conta fechar.
              </p>
            </>
          ) : (
            <p className="text-sm text-slate-400">Sem gasto implícito nem registrado entre as duas conferências.</p>
          )}
        </div>
      ) : (
        <p className="text-[11px] text-slate-600" data-testid="balance-quiet">
          {checks.length === 1 ? 'Uma conferência guardada. A taxa de captura aparece quando houver a segunda — sem pressa.' : 'Opcional. Anote o saldo que você tem em mãos, quando quiser; duas conferências dizem quanto do seu gasto você está capturando.'}
        </p>
      )}

      {open && <BalanceSheet checks={checks} windows={windows} currency={currency} onClose={() => setOpen(false)} />}
    </section>
  )
}

function windowLabel(fromIso: string, toIso: string): string {
  const a = formatMonth(fromIso.slice(0, 7))
  const b = formatMonth(toIso.slice(0, 7))
  return a === b ? a : `${a} → ${b}`
}

function BalanceSheet({ checks, windows, currency, onClose }: { checks: BalanceCheck[]; windows: ReturnType<typeof captureRates>; currency: string; onClose: () => void }) {
  const [amount, setAmount] = useState('')
  const [account, setAccount] = useState(checks[checks.length - 1]?.account ?? DEFAULT_ACCOUNT)
  const [date, setDate] = useState(nowIso().slice(0, 16))
  const [note, setNote] = useState('')
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    const minor = keypadToMinor(amount.replace(',', '.'))
    if (minor == null) return setErr('Valor inválido')
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(date)) return setErr('Data inválida')
    await addBalanceCheck({ date: date.length === 16 ? `${date}:00` : date, account: account.trim() || DEFAULT_ACCOUNT, countedMinor: minor, note })
    setAmount('')
    setNote('')
    setErr(null)
  }

  return (
    <Sheet title="Conferência de saldo" onClose={onClose} testId="balance-sheet">
      <div className="space-y-3 text-sm">
        <p className="text-xs text-slate-500">Quanto você tem agora, de fato. Não é orçamento nem controle de saldo — é só para saber que fatia do gasto está sendo registrada.</p>
        <div className="flex items-center gap-2">
          <input
            inputMode="decimal"
            autoFocus
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))}
            placeholder="0,00"
            data-testid="balance-amount"
            className="h-11 min-w-0 flex-1 rounded-xl bg-slate-800 px-3 text-right text-2xl tabular-nums outline-none placeholder:text-slate-600"
          />
          <span className="text-xs text-slate-400">{currency}</span>
        </div>
        <div className="flex gap-2">
          <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="Conta" data-testid="balance-account" className="min-w-0 flex-1 rounded-xl bg-slate-800 px-3 py-2 outline-none" />
          <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} data-testid="balance-date" className="rounded-xl bg-slate-800 px-2 py-2 text-xs outline-none" />
        </div>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Nota (opcional)" className="w-full rounded-xl bg-slate-800 px-3 py-2 outline-none placeholder:text-slate-500" />
        {err && <p className="text-red-400">{err}</p>}
        <button type="button" data-testid="balance-save" onClick={() => void save()} className="w-full rounded-xl bg-amber-500 py-2.5 font-semibold text-slate-950">
          Guardar conferência
        </button>

        {windows.length > 0 && (
          <ul className="space-y-1 pt-2 text-xs" data-testid="capture-windows">
            {windows
              .slice()
              .reverse()
              .map((w) => (
                <li key={`${w.from.id}-${w.to.id}`} className="flex items-center justify-between gap-2 rounded-xl bg-slate-900/60 px-3 py-2">
                  <span className="text-slate-400">
                    {windowLabel(w.from.date, w.to.date)} · {w.account}
                  </span>
                  <span className="tabular-nums text-slate-200">{w.status === 'ok' && w.rate != null ? `${Math.round(w.rate * 100)}%` : w.status === 'unrecorded-income' ? 'receita não registrada' : '—'}</span>
                </li>
              ))}
          </ul>
        )}

        {checks.length > 0 && (
          <ul className="space-y-1 pt-2 text-xs" data-testid="balance-list">
            {checks
              .slice()
              .reverse()
              .map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 px-1 py-1">
                  <span className="text-slate-400">
                    {c.date.slice(0, 10)} · {c.account}
                    {c.note ? <span className="text-slate-600"> · {c.note}</span> : null}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums text-slate-200">{formatMinor(c.countedMinor, currency, { sign: false })}</span>
                    <button type="button" onClick={() => void removeBalanceCheck(c.id!)} className="text-slate-600 hover:text-red-400" aria-label="Excluir conferência">
                      ×
                    </button>
                  </span>
                </li>
              ))}
          </ul>
        )}
      </div>
    </Sheet>
  )
}
