import { useMemo, useState } from 'react'
import { declareUntracked } from '../db/mutations'
import type { UntrackedPeriod } from '../db/types'
import { addMonths, formatMonth, monthBounds } from '../lib/dates'
import type { MonthStat } from './engine'

interface Run {
  months: MonthStat[]
  start: string // first month key
  end: string // last month key
  count: number
}

/** Consecutive suspected months collapse into one run — one row, one tap. */
export function runsOf(months: MonthStat[]): Run[] {
  const runs: Run[] = []
  for (const m of months) {
    const last = runs[runs.length - 1]
    if (last && addMonths(last.end, 1) === m.month) {
      last.months.push(m)
      last.end = m.month
      last.count += m.count
    } else runs.push({ months: [m], start: m.month, end: m.month, count: m.count })
  }
  return runs
}

interface Props {
  suspects: MonthStat[]
  untracked: UntrackedPeriod[]
  currentMonth: string
}

/**
 * Spec §8 — the two coverage flavours, made actionable: suspected lapses get a one-tap
 * "I wasn't tracking then" that turns them into a declared period. Declared periods are listed
 * for context; they are managed in Ajustes.
 */
export function CoveragePanel({ suspects, untracked, currentMonth }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  // The current month is always partial — it is not a lapse, so it gets no button.
  const actionable = useMemo(() => runsOf(suspects.filter((m) => m.month !== currentMonth)), [suspects, currentMonth])
  if (!actionable.length && !untracked.length) return null
  const LIMIT = 3
  const visible = showAll ? actionable : actionable.slice(-LIMIT) // most recent first matters more

  return (
    <section data-testid="coverage-panel">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Cobertura</h2>
      {actionable.length > 0 && (
        <>
          <p className="mb-1.5 text-[11px] text-slate-500">Meses com poucos lançamentos (&lt;40% da mediana). Se foi decisão, um toque os declara — viram lacunas e saem das médias.</p>
          <ul className="space-y-1 text-xs" data-testid="suspect-months">
            {visible.map((r) => (
              <li key={r.start} className="flex items-center justify-between gap-2 rounded-xl bg-slate-900/60 px-3 py-2">
                <span className="min-w-0">
                  <span className="text-slate-200">{r.start === r.end ? formatMonth(r.start) : `${formatMonth(r.start)} → ${formatMonth(r.end)}`}</span>
                  <span className="text-slate-500">
                    {' '}
                    · {r.count} lanç.
                    {r.months.length === 1 && r.months[0].trailingMedianCount != null && ` · mediana ${Math.round(r.months[0].trailingMedianCount)}`}
                  </span>
                </span>
                <button
                  type="button"
                  data-testid={`declare-${r.start}`}
                  data-run-end={r.end}
                  disabled={busy === r.start}
                  onClick={async () => {
                    setBusy(r.start)
                    try {
                      await declareUntracked(monthBounds(r.start)[0], monthBounds(r.end)[1], 'não estava registrando')
                    } finally {
                      setBusy(null)
                    }
                  }}
                  className="shrink-0 rounded-full bg-slate-800 px-2.5 py-1 text-[11px] text-amber-300 active:scale-95 disabled:opacity-50"
                >
                  não estava registrando
                </button>
              </li>
            ))}
          </ul>
          {actionable.length > LIMIT && (
            <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-1.5 text-[11px] text-slate-500 underline-offset-2 hover:underline">
              {showAll ? 'menos' : `mais ${actionable.length - LIMIT}…`}
            </button>
          )}
        </>
      )}
      {untracked.length > 0 && (
        <p className="mt-2 text-[11px] text-slate-500" data-testid="untracked-summary">
          Sem registro (declarado):{' '}
          {untracked.map((p, i) => (
            <span key={p.id ?? i} className="text-slate-400">
              {i > 0 && ' · '}
              {p.start.slice(0, 7) === p.end.slice(0, 7) ? formatMonth(p.start.slice(0, 7)) : `${formatMonth(p.start.slice(0, 7))} → ${formatMonth(p.end.slice(0, 7))}`}
              {p.reason ? ` (${p.reason})` : ''}
            </span>
          ))}
          . Aparecem como lacunas, nunca como zero.
        </p>
      )}
    </section>
  )
}
