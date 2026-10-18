import type { Transaction, UntrackedPeriod } from '../db/types'
import { daysBetween, dayKey, fromLocalIso, monthBounds, monthKey } from '../lib/dates'
import { expenses, monthlyStats, untrackedDaysIn, type MonthStat } from './engine'

// Month-end projection and budget guidance. Pure, deterministic, integer minor units out.
//
// The question: "if I keep going like this, where does the month end?" Two answers are computed.
//
//  - pace   — this month alone: what's been spent, plus the everyday daily rate carried over the
//             days left. Big one-off rows are counted once, never multiplied out — a ¥2,000 bill
//             on the 3rd does not mean ¥20,000 by the 30th.
//  - trend  — the same, but the daily rate is blended with the recent months' rate (weighted
//             toward this month as it fills in), and the large spends a typical month still has
//             to come are added — "typical" being the median month, so one exceptional purchase
//             in the history doesn't leak into every month after it. This is the headline whenever there is history to lean on.
//
// "Lumpy" rows are top-ups (spec §3: a card load is not a daily habit) and any ticket at or above
// the 95th percentile of recent tickets. Everything else is "everyday" and drives the rate.
//
// The trend projection is backtested against the user's own past months — run as of the same
// day of the month, compared with how each month really ended — and the typical miss becomes the
// ± band. The band is earned, not assumed: with fewer than three past months there is none.
//
// Coverage rules from engine.ts carry over: declared untracked days are taken out of both the
// elapsed and the remaining day counts, and only fully tracked, non-incomplete months may serve
// as history.

export const BASELINE_MONTHS = 3 // months whose daily rate and lumps the trend leans on
export const THRESHOLD_MONTHS = 6 // months whose tickets set the "large" threshold
export const BACKTEST_MONTHS = 6
export const MIN_BACKTEST_SAMPLES = 3
export const LARGE_PERCENTILE = 0.95
export const LARGE_FLOOR_MINOR = 20_000 // never call anything under 200 (ref currency) a one-off
/** Days of this month's data that count as much as the history: w = elapsed / (elapsed + 7). */
export const SHRINK_DAYS = 7

export type ProjectionMethod = 'trend' | 'pace' | 'none'

export interface Projection {
  month: string
  asOf: string // 'YYYY-MM-DD'
  daysInMonth: number
  /** Days of the month not inside a declared untracked period. */
  trackedDays: number
  /** Tracked days from the 1st through asOf, inclusive. */
  elapsedDays: number
  /** Tracked days after asOf. */
  remainingDays: number
  asOfTracked: boolean

  /** Expenses dated on or before asOf. */
  spentMinor: number
  spentTodayMinor: number
  everydayMinor: number
  lumpyMinor: number
  lumpyCount: number
  /** Expenses already entered with a date later this month — known, counted once, not extrapolated. */
  scheduledMinor: number
  largeThresholdMinor: number

  currentDailyMinor: number | null
  baselineDailyMinor: number | null
  blendedDailyMinor: number | null
  /** Weight of this month's own rate in the blend, 0..1. */
  currentWeight: number
  baselineMonths: string[]
  baselineAvgTotalMinor: number | null
  /** Median lumpy spend per baseline month (median, so one exceptional month can't inflate it). */
  baselineLumpyMinor: number | null
  expectedLumpyRemainingMinor: number

  /** This month alone, no history. */
  paceMinor: number
  /** The headline estimate (trend when history exists, else pace). */
  projectedMinor: number
  method: ProjectionMethod
  band: ProjectionBand | null
}

export interface ProjectionBand {
  lowMinor: number
  highMinor: number
  /** Median absolute relative miss of the trend projection in past months, as of the same day. */
  typicalError: number
  samples: number
}

export interface ProjectionOptions {
  month: string
  asOf: string
  untracked?: UntrackedPeriod[]
  topUpIds?: Set<number>
  /** monthlyStats(txs, { untracked }) — pass it in when the caller already has it. */
  stats?: MonthStat[]
  /** Count rows dated after asOf as already-known spend (live use). Off for backtests. */
  includeScheduled?: boolean
  backtest?: boolean
}

const day = (t: Transaction) => t.date.slice(0, 10)
const p2 = (n: number) => String(n).padStart(2, '0')

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = xs.slice().sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Nearest-rank percentile of a non-empty list. */
function percentile(xs: number[], q: number): number {
  const s = xs.slice().sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil(q * s.length))
  return s[rank - 1]
}

/** Months fit to be history for `month`: before it, fully tracked, not a suspected lapse. */
export function historyMonths(stats: MonthStat[], month: string): MonthStat[] {
  return stats.filter((m) => m.month < month && m.coverage === 'ok' && m.untrackedDays === 0 && m.count > 0)
}

/** Ticket size at which a non-top-up expense counts as a one-off rather than everyday spend. */
export function largeThreshold(txs: Transaction[], months: string[], topUpIds?: Set<number>): number {
  if (!months.length) return LARGE_FLOOR_MINOR
  const set = new Set(months)
  const values: number[] = []
  for (const t of expenses(txs)) if (set.has(monthKey(t.date)) && !topUpIds?.has(t.categoryId)) values.push(-t.refAmountMinor)
  if (!values.length) return LARGE_FLOOR_MINOR
  return Math.max(LARGE_FLOOR_MINOR, percentile(values, LARGE_PERCENTILE))
}

function nextDay(d: string): string {
  return dayKey(fromLocalIso(d), 1)
}

export function projectMonth(txs: Transaction[], opts: ProjectionOptions): Projection {
  const { month, untracked, topUpIds, includeScheduled = true, backtest = true } = opts
  const stats = opts.stats ?? monthlyStats(txs, { untracked })
  const [mStart, mEnd] = monthBounds(month)
  const daysInMonth = Number(mEnd.slice(8, 10))
  const asOf = opts.asOf > mEnd ? mEnd : opts.asOf

  const trackedDays = daysInMonth - untrackedDaysIn(mStart, mEnd, untracked)
  let elapsedDays = 0
  let remainingDays = trackedDays
  let asOfTracked = false
  if (asOf >= mStart) {
    elapsedDays = daysBetween(mStart, asOf) + 1 - untrackedDaysIn(mStart, asOf, untracked)
    remainingDays = asOf < mEnd ? daysBetween(asOf, mEnd) - untrackedDaysIn(nextDay(asOf), mEnd, untracked) : 0
    asOfTracked = untrackedDaysIn(asOf, asOf, untracked) === 0
  }

  // History: the recent fully tracked months before this one.
  const history = historyMonths(stats, month)
  const thresholdMonths = history.slice(-THRESHOLD_MONTHS).map((m) => m.month)
  const baselineMonths = history.slice(-BASELINE_MONTHS).map((m) => m.month)
  const threshold = largeThreshold(txs, thresholdMonths, topUpIds)
  const isLumpy = (t: Transaction) => !!topUpIds?.has(t.categoryId) || -t.refAmountMinor >= threshold

  let spentMinor = 0
  let spentTodayMinor = 0
  let everydayMinor = 0
  let lumpyMinor = 0
  let lumpyCount = 0
  let scheduledMinor = 0
  const baseSet = new Set(baselineMonths)
  const baseEveryday = new Map<string, number>()
  const baseLumpy = new Map<string, number>()
  for (const t of expenses(txs)) {
    const m = monthKey(t.date)
    const v = -t.refAmountMinor
    if (m === month) {
      const d = day(t)
      if (d > asOf) {
        if (includeScheduled) scheduledMinor += v
        continue
      }
      spentMinor += v
      if (d === asOf) spentTodayMinor += v
      if (isLumpy(t)) {
        lumpyMinor += v
        lumpyCount++
      } else everydayMinor += v
    } else if (baseSet.has(m)) {
      const target = isLumpy(t) ? baseLumpy : baseEveryday
      target.set(m, (target.get(m) ?? 0) + v)
    }
  }

  let baselineDailyMinor: number | null = null
  let baselineLumpyMinor: number | null = null
  let baselineAvgTotalMinor: number | null = null
  if (baselineMonths.length) {
    let everyday = 0
    let lumpy = 0
    let days = 0
    for (const m of baselineMonths) {
      everyday += baseEveryday.get(m) ?? 0
      lumpy += baseLumpy.get(m) ?? 0
      days += Number(monthBounds(m)[1].slice(8, 10)) // history months have no untracked days
    }
    baselineDailyMinor = everyday / days
    // Median, not mean: one flight or deposit in one past month must not make every later month
    // expect a slice of it. The everyday rate is pooled across days, where a single item can't dominate.
    baselineLumpyMinor = median(baselineMonths.map((m) => baseLumpy.get(m) ?? 0))
    baselineAvgTotalMinor = Math.round((everyday + lumpy) / baselineMonths.length)
  }

  const currentDailyMinor = elapsedDays > 0 ? everydayMinor / elapsedDays : null
  const currentWeight = elapsedDays / (elapsedDays + SHRINK_DAYS)
  const blendedDailyMinor =
    baselineDailyMinor == null ? currentDailyMinor : currentDailyMinor == null ? baselineDailyMinor : currentWeight * currentDailyMinor + (1 - currentWeight) * baselineDailyMinor

  // Large spends a typical month still has ahead: the share of the usual lump total that falls in
  // the days left, but never more than what's left of the usual total once this month's lumps count.
  const lumpsSoFar = lumpyMinor + scheduledMinor
  const expectedLumpyRemainingMinor =
    baselineLumpyMinor == null || trackedDays <= 0
      ? 0
      : Math.round(Math.min((baselineLumpyMinor * remainingDays) / trackedDays, Math.max(0, baselineLumpyMinor - lumpsSoFar)))

  const known = spentMinor + scheduledMinor
  const paceMinor = known + Math.round((currentDailyMinor ?? 0) * remainingDays)
  let method: ProjectionMethod
  let projectedMinor: number
  if (baselineDailyMinor != null) {
    method = 'trend'
    projectedMinor = known + Math.round((blendedDailyMinor ?? 0) * remainingDays) + expectedLumpyRemainingMinor
  } else if (elapsedDays > 0) {
    method = 'pace'
    projectedMinor = paceMinor
  } else {
    method = 'none'
    projectedMinor = known
  }

  let band: ProjectionBand | null = null
  if (backtest && method === 'trend') {
    const dom = Number(asOf.slice(8, 10))
    const totals = new Map(stats.map((m) => [m.month, m.totalMinor]))
    const errors: number[] = []
    for (const h of history.slice(-BACKTEST_MONTHS)) {
      const last = Number(monthBounds(h.month)[1].slice(8, 10))
      const past = projectMonth(txs, {
        month: h.month,
        asOf: `${h.month}-${p2(Math.min(dom, last))}`,
        untracked,
        topUpIds,
        stats,
        includeScheduled: false,
        backtest: false,
      })
      const actual = totals.get(h.month) ?? 0
      if (past.method === 'trend' && past.projectedMinor > 0) errors.push((actual - past.projectedMinor) / past.projectedMinor)
    }
    if (errors.length >= MIN_BACKTEST_SAMPLES) {
      const typicalError = median(errors.map(Math.abs))!
      band = {
        lowMinor: Math.max(known, Math.round(projectedMinor * (1 - typicalError))),
        highMinor: Math.round(projectedMinor * (1 + typicalError)),
        typicalError,
        samples: errors.length,
      }
    }
  }

  return {
    month,
    asOf,
    daysInMonth,
    trackedDays,
    elapsedDays,
    remainingDays,
    asOfTracked,
    spentMinor,
    spentTodayMinor,
    everydayMinor,
    lumpyMinor,
    lumpyCount,
    scheduledMinor,
    largeThresholdMinor: threshold,
    currentDailyMinor: currentDailyMinor == null ? null : Math.round(currentDailyMinor),
    baselineDailyMinor: baselineDailyMinor == null ? null : Math.round(baselineDailyMinor),
    blendedDailyMinor: blendedDailyMinor == null ? null : Math.round(blendedDailyMinor),
    currentWeight,
    baselineMonths,
    baselineAvgTotalMinor,
    baselineLumpyMinor: baselineLumpyMinor == null ? null : Math.round(baselineLumpyMinor),
    expectedLumpyRemainingMinor,
    paceMinor,
    projectedMinor,
    method,
    band,
  }
}

// ---------- Budget ----------

/** Stored under the 'monthlyBudget' setting. Kept with its currency so a ref-currency switch can't silently re-denominate it. */
export interface MonthlyBudget {
  amountMinor: number
  currency: string
}

export const BUDGET_SETTING = 'monthlyBudget'

export type BudgetStatus = 'ok' | 'tight' | 'over-projected' | 'over'
export const TIGHT_RATIO = 0.9

export interface BudgetGuidance {
  budgetMinor: number
  /** Spent so far, including rows already entered for later this month. */
  spentMinor: number
  /** budget − spent; negative once over. */
  remainingMinor: number
  /** Tracked days left including today. */
  daysLeft: number
  /**
   * What can go to everyday spending per day from today on and still land on budget: the budget
   * left at the start of today, minus the large spends a typical month still has ahead, spread
   * over the days left. Null on a month with no days left; 0 when nothing is left.
   */
  dailyAllowanceMinor: number | null
  /** The part of the budget set aside for the large spends still expected (counted in the allowance). */
  reservedMinor: number
  spentTodayMinor: number
  /** Straight-line share of the budget for the tracked days elapsed. */
  expectedByNowMinor: number
  projectedMinor: number
  /** projection − budget: positive means the month is heading over. */
  projectedOverMinor: number
  status: BudgetStatus
}

export function budgetGuidance(p: Projection, budgetMinor: number): BudgetGuidance {
  const spentMinor = p.spentMinor + p.scheduledMinor
  const daysLeft = p.remainingDays + (p.asOfTracked ? 1 : 0)
  const startOfToday = spentMinor - p.spentTodayMinor
  const reservedMinor = Math.max(0, Math.min(p.expectedLumpyRemainingMinor, budgetMinor - startOfToday))
  const dailyAllowanceMinor = daysLeft > 0 ? Math.max(0, Math.floor((budgetMinor - startOfToday - reservedMinor) / daysLeft)) : null
  const expectedByNowMinor = p.trackedDays > 0 ? Math.round((budgetMinor * p.elapsedDays) / p.trackedDays) : 0
  const projectedOverMinor = p.projectedMinor - budgetMinor
  let status: BudgetStatus
  if (spentMinor > budgetMinor) status = 'over'
  else if (p.projectedMinor > budgetMinor) status = 'over-projected'
  else if (p.projectedMinor > budgetMinor * TIGHT_RATIO) status = 'tight'
  else status = 'ok'
  return {
    budgetMinor,
    spentMinor,
    remainingMinor: budgetMinor - spentMinor,
    daysLeft,
    dailyAllowanceMinor,
    reservedMinor,
    spentTodayMinor: p.spentTodayMinor,
    expectedByNowMinor,
    projectedMinor: p.projectedMinor,
    projectedOverMinor,
    status,
  }
}

/**
 * A starting point for the budget: the median total of the last six fully tracked months,
 * rounded to the nearest 100 (ref currency). Null without history.
 */
export function suggestBudget(stats: MonthStat[], month: string): number | null {
  const totals = historyMonths(stats, month)
    .slice(-THRESHOLD_MONTHS)
    .map((m) => m.totalMinor)
  const med = median(totals)
  return med == null ? null : Math.round(med / 10_000) * 10_000
}
