import { useState } from 'react'
import { useUntrackedPeriods } from '../db/hooks'
import { declareUntracked, removeUntracked } from '../db/mutations'
import { dayKey, formatDayFull } from '../lib/dates'

/** Spec §8 — declared untracked ranges: a gap in every chart, never a zero, never averaged in. */
export function UntrackedPeriods() {
  const periods = useUntrackedPeriods() ?? []
  const [adding, setAdding] = useState(false)
  const [start, setStart] = useState(dayKey())
  const [end, setEnd] = useState(dayKey())
  const [reason, setReason] = useState('')
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return setErr('Datas inválidas')
    await declareUntracked(start, end, reason.trim() || undefined)
    setAdding(false)
    setReason('')
    setErr(null)
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm" data-testid="untracked-card">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Períodos sem registro</p>
        <button type="button" data-testid="untracked-add" onClick={() => setAdding((a) => !a)} className="rounded-full bg-slate-800 px-2.5 py-1 text-[11px] text-slate-300">
          {adding ? 'cancelar' : '+ declarar'}
        </button>
      </div>
      <p className="mb-2 text-[11px] text-slate-500">Viagem, férias, decisão de não registrar. Esses dias viram lacunas nos gráficos — não zeros — e ficam fora das médias.</p>

      {adding && (
        <div className="mb-3 space-y-2 rounded-xl bg-slate-800/60 p-3">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <label className="flex flex-1 flex-col gap-1">
              de
              <input type="date" value={start} onChange={(e) => setStart(e.target.value)} data-testid="untracked-start" className="rounded-lg bg-slate-800 px-2 py-1.5 text-slate-100 outline-none" />
            </label>
            <label className="flex flex-1 flex-col gap-1">
              até
              <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} data-testid="untracked-end" className="rounded-lg bg-slate-800 px-2 py-1.5 text-slate-100 outline-none" />
            </label>
          </div>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo (opcional) — ex. viagem" data-testid="untracked-reason" className="w-full rounded-lg bg-slate-800 px-2 py-1.5 text-xs outline-none placeholder:text-slate-500" />
          {err && <p className="text-xs text-red-400">{err}</p>}
          <button type="button" data-testid="untracked-save" onClick={() => void save()} className="w-full rounded-lg bg-amber-500 py-2 text-xs font-semibold text-slate-950">
            Declarar
          </button>
        </div>
      )}

      {periods.length === 0 ? (
        <p className="text-xs text-slate-600">Nenhum período declarado.</p>
      ) : (
        <ul className="space-y-1 text-xs" data-testid="untracked-list">
          {periods.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 rounded-xl bg-slate-800/40 px-3 py-2">
              <span className="min-w-0">
                <span className="text-slate-200">
                  {formatDayFull(p.start)} → {formatDayFull(p.end)}
                </span>
                {p.reason && <span className="text-slate-500"> · {p.reason}</span>}
              </span>
              <button type="button" onClick={() => void removeUntracked(p.id!)} className="shrink-0 text-slate-600 hover:text-red-400" aria-label="Remover período">
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
