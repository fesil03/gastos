import type { BalanceCheck, Category, Group, Transaction, UntrackedPeriod } from '../db/types'
import { addMonths, dayKey, daysBetween, hourOf, monthBounds, monthKey, weekdayOf } from '../lib/dates'

// Insights engine — spec §8. Pure, deterministic, integer arithmetic on refAmountMinor.
// "Expense" = refAmountMinor < 0. All totals are returned as positive minor units.
//
// Two rules from spec §3 / §8 run through everything here:
//  - Top-up categories (campus-card loads) stay IN every spend total but are excluded from
//    ticket-size statistics and the time-of-day heatmap — pass their ids as `exclude`.
//  - Declared untracked periods are gaps, never zeros: they are not flagged incomplete, never
//    enter a baseline, and never dilute an average.

export const SMALL_TICKET_MINOR = 3000 // sub-30 in the reference currency
export const INCOMPLETE_RATIO = 0.4 // month count < 40% of trailing median → incomplete

export type Coverage = 'ok' | 'incomplete' | 'untracked'

export interface MonthStat {
  month: string
  count: number
  totalMinor: number
  /** 'untracked' = whole month inside a declared period; 'incomplete' = suspected lapse (spec §8). */
  coverage: Coverage
  /** Convenience: coverage === 'incomplete'. Untracked months are NOT incomplete. */
  incomplete: boolean
  /** Days of the month inside a declared untracked period (0..daysInMonth). */
  untrackedDays: number
  daysInMonth: number
  trailingMedianCount: number | null
  topCategories: { categoryId: number; totalMinor: number }[]
}

/** Count the days of [fromDay, toDay] (inclusive) covered by any declared period. */
export function untrackedDaysIn(fromDay: string, toDay: string, periods: UntrackedPeriod[] | undefined): number {
  if (!periods?.length) return 0
  // Periods are kept disjoint by the mutation layer, but be safe and merge here too.
  const sorted = periods
    .map((p) => ({ s: p.start > fromDay ? p.start : fromDay, e: p.end < toDay ? p.end : toDay }))
    .filter((p) => p.s <= p.e)
    .sort((a, b) => a.s.localeCompare(b.s))
  let days = 0
  let curS: string | null = null
  let curE: string | null = null
  for (const p of sorted) {
    if (curE != null && p.s <= curE) {
      if (p.e > curE) curE = p.e
      continue
    }
    if (curS != null) days += daysBetween(curS, curE!) + 1
    curS = p.s
    curE = p.e
  }
  if (curS != null) days += daysBetween(curS, curE!) + 1
  return days
}

export function isDayUntracked(day: string, periods: UntrackedPeriod[] | undefined): boolean {
  return !!periods?.some((p) => p.start <= day && day <= p.end)
}

function exclude(txs: Transaction[], ids?: Set<number>): Transaction[] {
  return ids?.size ? txs.filter((t) => !ids.has(t.categoryId)) : txs
}

export function expenses(txs: Iterable<Transaction>): Transaction[] {
  const out: Transaction[] = []
  for (const t of txs) if (t.refAmountMinor < 0) out.push(t)
  return out
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = xs.slice().sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Monthly totals with coverage awareness (spec §8). Every calendar month between the first and
 * last transaction is present.
 *  - A month wholly inside a declared untracked period is `untracked`: a gap, not a zero. It is
 *    never flagged, never enters the trailing baseline.
 *  - Otherwise the month is `incomplete` when its count is below 40% of the median of the trailing
 *    6 baseline months (baseline = fully tracked, not incomplete). A partially untracked month is
 *    judged against the threshold scaled by its tracked-day share, and does not join the baseline.
 *  - The first months (before any baseline exists) are retro-judged against the first baseline.
 */
export function monthlyStats(
  txs: Transaction[],
  opts: { trailing?: number; upTo?: string; untracked?: UntrackedPeriod[] } = {},
): MonthStat[] {
  const { trailing = 6, untracked } = opts
  const exp = expenses(txs)
  if (!exp.length) return []
  const byMonth = new Map<string, { count: number; total: number; cats: Map<number, number> }>()
  for (const t of exp) {
    const m = monthKey(t.date)
    let b = byMonth.get(m)
    if (!b) byMonth.set(m, (b = { count: 0, total: 0, cats: new Map() }))
    b.count++
    b.total += -t.refAmountMinor
    b.cats.set(t.categoryId, (b.cats.get(t.categoryId) ?? 0) + -t.refAmountMinor)
  }
  const months = [...byMonth.keys()].sort()
  const first = months[0]
  const last = opts.upTo ?? months[months.length - 1]
  const all: string[] = []
  for (let m = first; m <= last; m = addMonths(m, 1)) all.push(m)

  const out: MonthStat[] = []
  const baseline: number[] = []
  for (const m of all) {
    const b = byMonth.get(m)
    const count = b?.count ?? 0
    const [mStart, mEnd] = monthBounds(m)
    const daysInMonth = Number(mEnd.slice(8, 10))
    const untrackedDays = untrackedDaysIn(mStart, mEnd, untracked)
    const trackedShare = (daysInMonth - untrackedDays) / daysInMonth
    const ref = median(baseline.slice(-trailing))

    let coverage: Coverage
    if (untrackedDays >= daysInMonth) coverage = 'untracked'
    else if (ref == null) coverage = count === 0 ? 'incomplete' : 'ok' // nothing to compare against yet
    else coverage = count < ref * INCOMPLETE_RATIO * trackedShare ? 'incomplete' : 'ok'

    if (coverage === 'ok' && untrackedDays === 0) baseline.push(count)
    out.push({
      month: m,
      count,
      totalMinor: b?.total ?? 0,
      coverage,
      incomplete: coverage === 'incomplete',
      untrackedDays,
      daysInMonth,
      trailingMedianCount: ref,
      topCategories: b ? [...b.cats.entries()].sort((a, z) => z[1] - a[1]).slice(0, 3).map(([categoryId, totalMinor]) => ({ categoryId, totalMinor })) : [],
    })
  }
  // Retro-judge leading months against the first stable baseline.
  const firstRef = out.find((m) => m.trailingMedianCount != null)?.trailingMedianCount
  if (firstRef != null) {
    for (const m of out) {
      if (m.trailingMedianCount != null) break
      if (m.coverage !== 'untracked') {
        const trackedShare = (m.daysInMonth - m.untrackedDays) / m.daysInMonth
        m.coverage = m.count < firstRef * INCOMPLETE_RATIO * trackedShare ? 'incomplete' : 'ok'
        m.incomplete = m.coverage === 'incomplete'
      }
      m.trailingMedianCount = firstRef
    }
  }
  return out
}

/** Months that look like a lapse and are not declared — candidates for the one-tap "I wasn't tracking then". */
export function suspectedIncomplete(stats: MonthStat[]): MonthStat[] {
  return stats.filter((m) => m.coverage === 'incomplete')
}

export interface Breakdown {
  id: number
  count: number
  totalMinor: number
  share: number // 0..1 of the period's expense total
  meanMinor: number
}

export function groupBreakdown(txs: Transaction[], categoryById: Map<number, Category>): Breakdown[] {
  return breakdownBy(expenses(txs), (t) => categoryById.get(t.categoryId)?.groupId ?? -1)
}

export function categoryBreakdown(txs: Transaction[]): Breakdown[] {
  return breakdownBy(expenses(txs), (t) => t.categoryId)
}

function breakdownBy(exp: Transaction[], keyOf: (t: Transaction) => number): Breakdown[] {
  const acc = new Map<number, { count: number; total: number }>()
  let grand = 0
  for (const t of exp) {
    const k = keyOf(t)
    const a = acc.get(k) ?? { count: 0, total: 0 }
    a.count++
    a.total += -t.refAmountMinor
    grand += -t.refAmountMinor
    acc.set(k, a)
  }
  return [...acc.entries()]
    .map(([id, a]) => ({ id, count: a.count, totalMinor: a.total, share: grand ? a.total / grand : 0, meanMinor: Math.round(a.total / a.count) }))
    .sort((a, b) => b.totalMinor - a.totalMinor)
}

/**
 * Average daily spend over the last N days ending `today` (inclusive). Days with no entries
 * count as zero — unless they fall in a declared untracked period, which are removed from the
 * denominator (spec §8: never averaged in). Returns null when no day in the window was tracked.
 */
export function rollingDailyAverage(txs: Transaction[], days: number, today = dayKey(), untracked?: UntrackedPeriod[]): number | null {
  const from = dayKey(new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10))), -(days - 1))
  const trackedDays = days - untrackedDaysIn(from, today, untracked)
  if (trackedDays <= 0) return null
  let sum = 0
  for (const t of expenses(txs)) {
    const d = t.date.slice(0, 10)
    if (d >= from && d <= today && !isDayUntracked(d, untracked)) sum += -t.refAmountMinor
  }
  return Math.round(sum / trackedDays)
}

/** 7 weekdays (Mon..Sun) × 24 hours: count and total. Top-ups (`excludeIds`) are left out — a card load at 18:09 is not a dinner. */
export function hourWeekdayHeatmap(txs: Transaction[], excludeIds?: Set<number>): { count: number[][]; totalMinor: number[][]; maxCount: number; maxTotal: number } {
  const count = Array.from({ length: 7 }, () => Array<number>(24).fill(0))
  const totalMinor = Array.from({ length: 7 }, () => Array<number>(24).fill(0))
  let maxCount = 0
  let maxTotal = 0
  for (const t of exclude(expenses(txs), excludeIds)) {
    const w = weekdayOf(t.date)
    const h = hourOf(t.date)
    count[w][h]++
    totalMinor[w][h] += -t.refAmountMinor
    if (count[w][h] > maxCount) maxCount = count[w][h]
    if (totalMinor[w][h] > maxTotal) maxTotal = totalMinor[w][h]
  }
  return { count, totalMinor, maxCount, maxTotal }
}

export interface LeakageMonth {
  month: string
  smallCount: number
  smallTotalMinor: number
  count: number
  totalMinor: number
}

/** Sub-threshold transactions per month: count, sum, and their share of the month. Top-ups excluded (spec §3). */
export function smallTicketLeakage(txs: Transaction[], threshold = SMALL_TICKET_MINOR, excludeIds?: Set<number>): LeakageMonth[] {
  const by = new Map<string, LeakageMonth>()
  for (const t of exclude(expenses(txs), excludeIds)) {
    const m = monthKey(t.date)
    let b = by.get(m)
    if (!b) by.set(m, (b = { month: m, smallCount: 0, smallTotalMinor: 0, count: 0, totalMinor: 0 }))
    const v = -t.refAmountMinor
    b.count++
    b.totalMinor += v
    if (v < threshold) {
      b.smallCount++
      b.smallTotalMinor += v
    }
  }
  return [...by.values()].sort((a, b) => a.month.localeCompare(b.month))
}

export interface TicketStats {
  count: number
  medianMinor: number
  meanMinor: number
  smallCount: number
  smallShare: number // 0..1 of count
  excludedTopUps: number // how many rows were left out as top-ups
}

/** Ticket-size statistics over the expenses given, with top-ups removed first (spec §3). */
export function ticketStats(txs: Transaction[], excludeIds?: Set<number>, threshold = SMALL_TICKET_MINOR): TicketStats {
  const exp = expenses(txs)
  const kept = exclude(exp, excludeIds)
  const values = kept.map((t) => -t.refAmountMinor).sort((a, b) => a - b)
  const n = values.length
  const medianMinor = n ? (n % 2 ? values[n >> 1] : Math.round((values[(n >> 1) - 1] + values[n >> 1]) / 2)) : 0
  const sum = values.reduce((a, b) => a + b, 0)
  const smallCount = values.filter((v) => v < threshold).length
  return { count: n, medianMinor, meanMinor: n ? Math.round(sum / n) : 0, smallCount, smallShare: n ? smallCount / n : 0, excludedTopUps: exp.length - n }
}

export interface Drift {
  categoryId: number
  currentMinor: number
  baselineMinor: number // trailing 3-month average (complete months only)
  deltaMinor: number
}

/** This month vs trailing 3 complete months, per category, sorted by |delta|. */
export function categoryDrift(txs: Transaction[], month: string, monthStatsList = monthlyStats(txs)): Drift[] {
  const complete = new Set(monthStatsList.filter((m) => !m.incomplete).map((m) => m.month))
  const baselineMonths: string[] = []
  for (let m = addMonths(month, -1), i = 0; i < 12 && baselineMonths.length < 3; m = addMonths(m, -1), i++) {
    if (complete.has(m)) baselineMonths.push(m)
  }
  const cur = new Map<number, number>()
  const base = new Map<number, number>()
  for (const t of expenses(txs)) {
    const m = monthKey(t.date)
    if (m === month) cur.set(t.categoryId, (cur.get(t.categoryId) ?? 0) + -t.refAmountMinor)
    else if (baselineMonths.includes(m)) base.set(t.categoryId, (base.get(t.categoryId) ?? 0) + -t.refAmountMinor)
  }
  const ids = new Set([...cur.keys(), ...base.keys()])
  const n = baselineMonths.length || 1
  return [...ids]
    .map((categoryId) => {
      const currentMinor = cur.get(categoryId) ?? 0
      const baselineMinor = Math.round((base.get(categoryId) ?? 0) / n)
      return { categoryId, currentMinor, baselineMinor, deltaMinor: currentMinor - baselineMinor }
    })
    .sort((a, b) => Math.abs(b.deltaMinor) - Math.abs(a.deltaMinor))
}

/** Consecutive days with at least one transaction, ending today or yesterday. */
export function streak(txs: Transaction[], today = dayKey()): { current: number; longest: number; lastDay: string | null } {
  const days = new Set<string>()
  for (const t of txs) days.add(t.date.slice(0, 10))
  if (!days.size) return { current: 0, longest: 0, lastDay: null }
  const sorted = [...days].sort()
  let longest = 1
  let run = 1
  for (let i = 1; i < sorted.length; i++) {
    run = daysBetween(sorted[i - 1], sorted[i]) === 1 ? run + 1 : 1
    if (run > longest) longest = run
  }
  const lastDay = sorted[sorted.length - 1]
  const gap = daysBetween(lastDay, today)
  if (gap > 1) return { current: 0, longest, lastDay }
  let current = 1
  for (let i = sorted.length - 1; i > 0; i--) {
    if (daysBetween(sorted[i - 1], sorted[i]) === 1) current++
    else break
  }
  return { current, longest, lastDay }
}

/** Convenience: transactions whose day falls in [fromDay, toDay]. */
export function inRange(txs: Transaction[], fromDay: string, toDay: string): Transaction[] {
  const lo = `${fromDay}T00:00:00`
  const hi = `${toDay}T23:59:59`
  return txs.filter((t) => t.date >= lo && t.date <= hi)
}

export function groupName(groups: Map<number, Group>, id: number): string {
  return groups.get(id)?.name ?? 'Outros'
}

// ---------- Balance check → capture rate (spec §8.1) ----------

export interface CaptureWindow {
  from: BalanceCheck
  to: BalanceCheck
  account: string
  /** Balance drop plus income logged in the window = what was actually spent. */
  impliedSpendMinor: number
  loggedSpendMinor: number
  incomeMinor: number
  /** logged / implied, or null when the arithmetic cannot hold. */
  rate: number | null
  status: 'ok' | 'unrecorded-income' | 'no-spend'
}

/**
 * For each pair of consecutive checks on the same account: implied spend = (counted before −
 * counted after) + income logged in between; capture rate = logged spend / implied spend.
 * One check alone yields nothing (never nag). A rate above 100% — or a balance that rose more
 * than logged income explains — means there is unrecorded income in the window, and we say so
 * instead of showing a nonsense figure.
 */
export function captureRates(checks: BalanceCheck[], txs: Transaction[]): CaptureWindow[] {
  const byAccount = new Map<string, BalanceCheck[]>()
  for (const c of checks) {
    const list = byAccount.get(c.account) ?? []
    list.push(c)
    byAccount.set(c.account, list)
  }
  const out: CaptureWindow[] = []
  for (const [account, list] of byAccount) {
    const sorted = list.slice().sort((a, b) => a.date.localeCompare(b.date))
    for (let i = 1; i < sorted.length; i++) {
      const from = sorted[i - 1]
      const to = sorted[i]
      let logged = 0
      let income = 0
      for (const t of txs) {
        if (t.date <= from.date || t.date > to.date) continue
        if (t.refAmountMinor < 0) logged += -t.refAmountMinor
        else income += t.refAmountMinor
      }
      const implied = from.countedMinor - to.countedMinor + income
      let status: CaptureWindow['status'] = 'ok'
      let rate: number | null = null
      if (implied <= 0) status = logged > 0 ? 'unrecorded-income' : 'no-spend'
      else {
        rate = logged / implied
        if (rate > 1) status = 'unrecorded-income'
      }
      out.push({ from, to, account, impliedSpendMinor: implied, loggedSpendMinor: logged, incomeMinor: income, rate, status })
    }
  }
  return out.sort((a, b) => a.to.date.localeCompare(b.to.date))
}
