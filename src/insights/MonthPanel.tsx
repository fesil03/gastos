import { useState } from 'react'
import { formatMonth } from '../lib/dates'
import { formatMinor, minorToKeypad, parseTypedAmount } from '../lib/money'
import { compact } from './charts'
import type { BudgetGuidance, BudgetStatus, MonthlyBudget, Projection } from './projection'
import { saveBudget, type MonthOutlook } from './useMonthOutlook'

/**
 * "Este mês" — where the month is heading and what that means against the budget. Always about
 * the current calendar month, whatever period the rest of Insights is showing.
 */
export function MonthPanel({ outlook }: { outlook: MonthOutlook }) {
  const { projection: p, guidance: g, budget, currency, month } = outlook
  const money = (m: number) => formatMinor(m, currency, { sign: false })

  if (p.trackedDays === 0) {
    return (
      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-xs text-slate-400" data-testid="month-panel">
        <Header month={month} p={p} />
        <p className="mt-2">Este mês está marcado como sem registro — não há o que projetar.</p>
      </section>
    )
  }

  const known = p.spentMinor + p.scheduledMinor
  const tone = g ? TONE[g.status] : TONE.ok

  return (
    <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-4" data-testid="month-panel">
      <Header month={month} p={p} />

      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-[11px] text-slate-500">gasto até hoje</p>
          <p className="text-2xl font-semibold tabular-nums leading-tight" data-testid="month-spent">
            {money(known)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[11px] text-slate-500">{p.method === 'pace' ? 'projeção (só este mês)' : 'projeção p/ fim do mês'}</p>
          <p className={`text-2xl font-semibold tabular-nums leading-tight ${tone.text}`} data-testid="month-projection">
            {p.method === 'none' ? '—' : money(p.projectedMinor)}
          </p>
        </div>
      </div>

      <ProgressBar p={p} g={g} budget={budget} tone={tone} />

      <p className="text-[11px] leading-relaxed text-slate-500" data-testid="month-context">
        {p.band ? (
          <>
            Provável entre <span className="text-slate-300">{compact(p.band.lowMinor, currency)}</span> e <span className="text-slate-300">{compact(p.band.highMinor, currency)}</span> — erro típico ±
            {Math.round(p.band.typicalError * 100)}% nos últimos {p.band.samples} meses, no mesmo dia do mês.
          </>
        ) : p.method === 'trend' ? (
          'Histórico ainda curto para medir a precisão.'
        ) : p.method === 'pace' ? (
          'Sem meses completos anteriores: projeção só pelo ritmo deste mês.'
        ) : (
          'Nada lançado ainda neste mês.'
        )}
        {p.method === 'trend' && (
          <>
            {' '}
            Só no ritmo deste mês: <span className="text-slate-300">{compact(p.paceMinor, currency)}</span>
            {p.baselineAvgTotalMinor != null && (
              <>
                {' '}
                · média recente <span className="text-slate-300">{compact(p.baselineAvgTotalMinor, currency)}</span>/mês
              </>
            )}
            .
          </>
        )}
      </p>

      <BudgetBlock outlook={outlook} />

      <HowItWorks p={p} currency={currency} />
    </section>
  )
}

function Header({ month, p }: { month: string; p: Projection }) {
  return (
    <div className="flex items-baseline justify-between">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Este mês · {formatMonth(month)}</h2>
      {p.trackedDays > 0 && (
        <span className="text-[11px] tabular-nums text-slate-500">
          dia {p.elapsedDays} de {p.trackedDays}
          {p.trackedDays < p.daysInMonth && ' registrados'}
        </span>
      )}
    </div>
  )
}

const TONE: Record<BudgetStatus, { text: string; bar: string; ahead: string }> = {
  ok: { text: 'text-slate-100', bar: 'bg-amber-400', ahead: 'bg-amber-400/25' },
  tight: { text: 'text-amber-300', bar: 'bg-amber-400', ahead: 'bg-amber-400/25' },
  'over-projected': { text: 'text-rose-300', bar: 'bg-amber-400', ahead: 'bg-rose-400/35' },
  over: { text: 'text-rose-300', bar: 'bg-rose-400', ahead: 'bg-rose-400/35' },
}

function ProgressBar({ p, g, budget, tone }: { p: Projection; g: BudgetGuidance | null; budget: MonthlyBudget | null; tone: (typeof TONE)[BudgetStatus] }) {
  const known = p.spentMinor + p.scheduledMinor
  const top = Math.max(known, p.band?.highMinor ?? p.projectedMinor, p.projectedMinor, budget?.amountMinor ?? 0, 1) * 1.04
  const pct = (m: number) => `${Math.min(100, (m / top) * 100)}%`
  return (
    <div>
      <div className="relative h-3 rounded-full bg-slate-800" role="img" aria-label="Gasto, projeção e orçamento do mês">
        {p.method !== 'none' && <div className={`absolute inset-y-0 left-0 rounded-full ${tone.ahead}`} style={{ width: pct(p.projectedMinor) }} />}
        {p.band && p.band.highMinor > p.band.lowMinor && (
          <div className="absolute top-1/2 h-0.5 -translate-y-1/2 rounded bg-slate-300/50" style={{ left: pct(p.band.lowMinor), width: `calc(${pct(p.band.highMinor)} - ${pct(p.band.lowMinor)})` }} />
        )}
        <div className={`absolute inset-y-0 left-0 rounded-full ${tone.bar}`} style={{ width: pct(known) }} />
        {g && <div className="absolute -top-1 h-1.5 w-px bg-slate-400" style={{ left: pct(g.expectedByNowMinor) }} title="ritmo linear até hoje" />}
        {budget && <div className="absolute -inset-y-1 w-0.5 rounded bg-slate-100" style={{ left: `calc(${pct(budget.amountMinor)} - 1px)` }} title="orçamento" />}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-500">
        <span className="flex items-center gap-1">
          <span className={`h-2 w-2 rounded-sm ${tone.bar}`} /> gasto
        </span>
        <span className="flex items-center gap-1">
          <span className={`h-2 w-2 rounded-sm ${tone.ahead}`} /> projeção
        </span>
        {budget && (
          <span className="flex items-center gap-1">
            <span className="h-2.5 w-0.5 bg-slate-100" /> orçamento
          </span>
        )}
        {g && (
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-px bg-slate-400" /> ritmo linear até hoje
          </span>
        )}
      </div>
    </div>
  )
}

function BudgetBlock({ outlook }: { outlook: MonthOutlook }) {
  const { guidance: g, budget, otherCurrencyBudget, currency, suggestionMinor, projection: p } = outlook
  const [editing, setEditing] = useState(false)
  const money = (m: number) => formatMinor(m, currency, { sign: false })

  if (!budget || editing) {
    return (
      <div className="rounded-xl bg-slate-800/50 p-3" data-testid="budget-editor-block">
        <p className="mb-2 text-xs text-slate-300">{budget ? 'Orçamento mensal' : 'Defina um teto de gasto por mês'}</p>
        {otherCurrencyBudget && !budget && (
          <p className="mb-2 text-[11px] text-amber-300/90">
            O orçamento salvo está em {otherCurrencyBudget.currency} ({formatMinor(otherCurrencyBudget.amountMinor, otherCurrencyBudget.currency, { sign: false })}); a moeda de referência agora é {currency}.
          </p>
        )}
        <BudgetEditor currency={currency} initialMinor={budget?.amountMinor ?? null} suggestionMinor={suggestionMinor} onDone={() => setEditing(false)} canCancel={!!budget} />
      </div>
    )
  }
  if (!g) return null

  const pctOfBudget = Math.round((g.projectedMinor / g.budgetMinor) * 100)
  const status: Record<BudgetStatus, string> = {
    ok: `No caminho — a projeção fica em ${pctOfBudget}% do orçamento.`,
    tight: `Apertado — a projeção fica em ${pctOfBudget}% do orçamento.`,
    'over-projected': `Nesse ritmo, o mês passa do orçamento em ${money(g.projectedOverMinor)}.`,
    over: `Orçamento estourado em ${money(-g.remainingMinor)}.`,
  }
  const todayOver = g.dailyAllowanceMinor != null && g.spentTodayMinor > g.dailyAllowanceMinor

  return (
    <div className="space-y-1.5 rounded-xl bg-slate-800/50 p-3 text-xs" data-testid="budget-block">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-slate-400">
          Orçamento <span className="tabular-nums text-slate-200">{money(g.budgetMinor)}</span>
          {g.remainingMinor >= 0 && (
            <>
              {' '}
              · resta <span className="tabular-nums text-slate-200">{money(g.remainingMinor)}</span>
            </>
          )}
        </p>
        <button type="button" onClick={() => setEditing(true)} className="shrink-0 text-[11px] text-slate-500 underline-offset-2 active:underline" data-testid="budget-edit">
          editar
        </button>
      </div>
      <p className={TONE[g.status].text} data-testid="budget-status">
        {status[g.status]}
      </p>
      {g.dailyAllowanceMinor != null && g.status !== 'over' && (
        <p className="text-slate-400" data-testid="budget-allowance">
          Para fechar no orçamento: até <span className="font-semibold tabular-nums text-slate-100">{money(g.dailyAllowanceMinor)}/dia</span> no dia a dia
          {g.daysLeft > 1 ? `, pelos próximos ${g.daysLeft} dias (com hoje)` : ' hoje'}.
          {p.currentDailyMinor != null && (
            <>
              {' '}
              Seu ritmo este mês: <span className="tabular-nums text-slate-300">{money(p.currentDailyMinor)}/dia</span>.
            </>
          )}
        </p>
      )}
      {g.dailyAllowanceMinor != null && g.status !== 'over' && (
        <p className="text-[11px] text-slate-500">
          Hoje: <span className={`tabular-nums ${todayOver ? 'text-amber-300' : 'text-slate-300'}`}>{money(g.spentTodayMinor)}</span> de {money(g.dailyAllowanceMinor)}
          {g.reservedMinor > 0 && <> · {money(g.reservedMinor)} já separados para os gastos grandes que um mês típico ainda tem (ex. top-ups)</>}
        </p>
      )}
    </div>
  )
}

function BudgetEditor({
  currency,
  initialMinor,
  suggestionMinor,
  onDone,
  canCancel,
}: {
  currency: string
  initialMinor: number | null
  suggestionMinor: number | null
  onDone: () => void
  canCancel: boolean
}) {
  const [text, setText] = useState(initialMinor != null ? minorToKeypad(initialMinor).replace('.', ',') : '')
  const parsed = parseTypedAmount(text)
  const save = async (m: number | null) => {
    await saveBudget(m, currency)
    onDone()
  }
  return (
    <div className="space-y-2">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (parsed != null) void save(parsed)
        }}
      >
        <label className="flex min-w-0 flex-1 items-center gap-1 rounded-lg bg-slate-900 px-2.5">
          <span className="text-xs text-slate-500">{currency}</span>
          <input
            inputMode="decimal"
            enterKeyHint="done"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={suggestionMinor != null ? minorToKeypad(suggestionMinor) : '0'}
            className="min-w-0 flex-1 bg-transparent py-2 text-sm tabular-nums text-slate-100 outline-none placeholder:text-slate-600"
            data-testid="budget-input"
            aria-label="Orçamento mensal"
          />
        </label>
        <button type="submit" disabled={parsed == null} className="rounded-lg bg-amber-500 px-3 text-xs font-semibold text-slate-950 disabled:opacity-40" data-testid="budget-save">
          Salvar
        </button>
      </form>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        {suggestionMinor != null && (
          <button type="button" onClick={() => void save(suggestionMinor)} className="rounded-full bg-slate-900 px-2.5 py-1 text-slate-300" data-testid="budget-suggest">
            usar {formatMinor(suggestionMinor, currency, { sign: false }).replace(/,00$/, '')} · sua mediana de 6 meses
          </button>
        )}
        {canCancel && (
          <>
            <button type="button" onClick={onDone} className="px-1 text-slate-500">
              cancelar
            </button>
            <button type="button" onClick={() => void save(null)} className="px-1 text-rose-300/80" data-testid="budget-clear">
              remover orçamento
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function HowItWorks({ p, currency }: { p: Projection; currency: string }) {
  const money = (m: number) => formatMinor(m, currency, { sign: false })
  const months = p.baselineMonths.map((m) => formatMonth(m).split(' ')[0]).join(', ')
  return (
    <details className="text-[11px] text-slate-500">
      <summary className="cursor-pointer select-none text-slate-500">como a projeção é calculada</summary>
      <ul className="mt-2 list-disc space-y-1 pl-4 leading-relaxed">
        <li>
          Dia a dia este mês: {money(p.everydayMinor)} em {p.elapsedDays} {p.elapsedDays === 1 ? 'dia' : 'dias'}
          {p.currentDailyMinor != null && ` → ${money(p.currentDailyMinor)}/dia`}.
        </li>
        <li>
          Gastos grandes (a partir de {money(p.largeThresholdMinor)}, e todo top-up) contam uma vez só, não são multiplicados: {money(p.lumpyMinor)}
          {p.lumpyCount > 0 && ` em ${p.lumpyCount} ${p.lumpyCount === 1 ? 'lançamento' : 'lançamentos'}`}.
          {p.scheduledMinor > 0 && ` Já lançado para depois de hoje: ${money(p.scheduledMinor)}.`}
        </li>
        {p.baselineDailyMinor != null && (
          <>
            <li>
              Histórico ({months}): {money(p.baselineDailyMinor)}/dia no dia a dia e {money(p.baselineLumpyMinor ?? 0)}/mês em gastos grandes. Meses incompletos ou sem registro ficam de fora.
            </li>
            <li>
              Ritmo usado para os {p.remainingDays} dias restantes: {Math.round(p.currentWeight * 100)}% este mês + {100 - Math.round(p.currentWeight * 100)}% histórico ={' '}
              {money(p.blendedDailyMinor ?? 0)}/dia. O peso deste mês cresce conforme o mês avança.
            </li>
            <li>Gastos grandes que um mês típico ainda teria: {money(p.expectedLumpyRemainingMinor)}.</li>
          </>
        )}
        {p.band && <li>A faixa vem de rodar esta mesma conta nos {p.band.samples} meses anteriores, no mesmo dia do mês, e comparar com como cada um terminou.</li>}
      </ul>
    </details>
  )
}
