import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { GastosDB } from '../db/db'
import { importWallet } from '../import/importer'
import type { BalanceCheck, Category, Group, Transaction, UntrackedPeriod } from '../db/types'
import {
  captureRates,
  categoryBreakdown,
  categoryDrift,
  groupBreakdown,
  hourWeekdayHeatmap,
  inRange,
  monthlyStats,
  rollingDailyAverage,
  smallTicketLeakage,
  streak,
  suspectedIncomplete,
  ticketStats,
  untrackedDaysIn,
} from './engine'

// The real export is personal data and is not committed; these suites need it and skip without it.
const EXPORT_FILE = resolve(__dirname, '../../fixtures/gastos_report_2026-05-02_203027.csv')
const describeWithExport = existsSync(EXPORT_FILE) ? describe : describe.skip
if (!existsSync(EXPORT_FILE)) console.warn(`skipping ${__filename.split('/').slice(-2).join('/')}: fixture missing`)

let txs: Transaction[]
let categoryById: Map<number, Category>
let groupById: Map<number, Group>
let idOf: (name: string) => number
let topUpIds: Set<number>
let untracked: UntrackedPeriod[]

beforeAll(async () => {
  const csv = readFileSync(resolve(__dirname, '../../fixtures/gastos_report_2026-05-02_203027.csv'), 'utf-8')
  const db = new GastosDB(`gastos-insights-${Date.now()}`)
  await importWallet(db, csv)
  txs = await db.transactions.toArray()
  const cats = await db.categories.toArray()
  categoryById = new Map(cats.map((c) => [c.id!, c]))
  groupById = new Map((await db.groups.toArray()).map((g) => [g.id!, g]))
  idOf = (name) => cats.find((c) => c.name === name)!.id!
  topUpIds = new Set(cats.filter((c) => c.isTopUp === 1).map((c) => c.id!))
  untracked = await db.untrackedPeriods.toArray() // seeded by the importer: 2025-01-01 → 2025-04-30
})

describeWithExport('monthlyStats', () => {
  it('covers every calendar month and flags the known tracking gaps as incomplete', () => {
    const ms = monthlyStats(txs)
    expect(ms[0].month).toBe('2023-05')
    expect(ms[ms.length - 1].month).toBe('2026-05')
    expect(ms).toHaveLength(37)
    const byMonth = new Map(ms.map((m) => [m.month, m]))
    // Without declared periods every gap is a suspected lapse (spec §1): Jun–Jul 2024 and Jan–Apr 2025.
    for (const m of ['2024-06', '2024-07', '2025-01', '2025-02', '2025-03', '2025-04']) {
      expect(byMonth.get(m)!.incomplete, m).toBe(true)
      expect(byMonth.get(m)!.coverage, m).toBe('incomplete')
    }
    expect(byMonth.get('2024-06')!.count + byMonth.get('2024-07')!.count).toBe(5)
    expect(byMonth.get('2025-01')!.count).toBe(0)
    // A busy month is complete.
    expect(byMonth.get('2026-04')!.incomplete).toBe(false)
    expect(byMonth.get('2026-04')!.count).toBeGreaterThan(40)
    // Totals are in the reference currency (BRL rows converted), so they sum to Σ -refAmountMinor,
    // not to the mixed-nominal 95,237.34 of the acceptance test.
    const refTotal = txs.reduce((s, t) => (t.refAmountMinor < 0 ? s - t.refAmountMinor : s), 0)
    expect(ms.reduce((s, m) => s + m.totalMinor, 0)).toBe(refTotal)
    expect(refTotal).toBe(9609687)
    // Top categories are populated and ordered.
    const apr = byMonth.get('2026-04')!
    expect(apr.topCategories).toHaveLength(3)
    expect(apr.topCategories[0].totalMinor).toBeGreaterThanOrEqual(apr.topCategories[1].totalMinor)
  })

  it('does not flag a partial current month differently from the rule', () => {
    // May 2026 has 2 days of data; it is below 40% of the trailing median → incomplete, by design.
    const ms = monthlyStats(txs)
    expect(ms[ms.length - 1].incomplete).toBe(true)
  })
})

describeWithExport('coverage — two flavours (spec §8)', () => {
  it('declared untracked months are gaps, not lapses; the lapse stays flagged', () => {
    expect(untracked).toHaveLength(1)
    const ms = monthlyStats(txs, { untracked })
    const byMonth = new Map(ms.map((m) => [m.month, m]))
    for (const m of ['2025-01', '2025-02', '2025-03', '2025-04']) {
      expect(byMonth.get(m)!.coverage, m).toBe('untracked')
      expect(byMonth.get(m)!.incomplete, m).toBe(false)
      expect(byMonth.get(m)!.untrackedDays).toBe(byMonth.get(m)!.daysInMonth)
    }
    for (const m of ['2024-06', '2024-07']) {
      expect(byMonth.get(m)!.coverage, m).toBe('incomplete')
      expect(byMonth.get(m)!.incomplete, m).toBe(true)
    }
    // The one-tap candidates are exactly the undeclared lapses (+ the 2-day partial month at the end).
    const suspects = suspectedIncomplete(ms).map((m) => m.month)
    expect(suspects).toContain('2024-06')
    expect(suspects).toContain('2024-07')
    expect(suspects).not.toContain('2025-02')
    expect(suspects.every((m) => !m.startsWith('2025-0'))).toBe(true)
    // Untracked months never enter the baseline: May 2025 is judged against pre-gap months, not zeros.
    expect(byMonth.get('2025-05')!.trailingMedianCount).toBeGreaterThan(20)
    // Totals are unchanged by coverage flags — top-ups and everything else stay in.
    expect(ms.reduce((s, m) => s + m.totalMinor, 0)).toBe(monthlyStats(txs).reduce((s, m) => s + m.totalMinor, 0))
  })

  it('converting a lapse into a declared period reclassifies it', () => {
    const declared = [...untracked, { start: '2024-06-01', end: '2024-07-31', reason: 'test' }]
    const byMonth = new Map(monthlyStats(txs, { untracked: declared }).map((m) => [m.month, m]))
    expect(byMonth.get('2024-06')!.coverage).toBe('untracked')
    expect(byMonth.get('2024-07')!.coverage).toBe('untracked')
    expect(byMonth.get('2024-08')!.coverage).toBe('ok')
  })

  it('a partially untracked month is judged against a scaled threshold and kept out of the baseline', () => {
    // Declare the second half of a busy month: it keeps its real count and must not be flagged.
    const half = [{ start: '2026-04-16', end: '2026-04-30' }]
    const byMonth = new Map(monthlyStats(txs, { untracked: half }).map((m) => [m.month, m]))
    const apr = byMonth.get('2026-04')!
    expect(apr.untrackedDays).toBe(15)
    expect(apr.coverage).toBe('ok')
    expect(apr.count).toBeGreaterThan(40)
  })

  it('untrackedDaysIn merges overlapping periods and clips to the range', () => {
    const ps = [
      { start: '2025-01-01', end: '2025-01-10' },
      { start: '2025-01-05', end: '2025-01-20' },
      { start: '2025-02-01', end: '2025-02-03' },
    ]
    expect(untrackedDaysIn('2025-01-01', '2025-01-31', ps)).toBe(20)
    expect(untrackedDaysIn('2025-01-15', '2025-02-02', ps)).toBe(6 + 2)
    expect(untrackedDaysIn('2025-03-01', '2025-03-31', ps)).toBe(0)
    expect(untrackedDaysIn('2025-01-01', '2025-01-31', undefined)).toBe(0)
  })
})

describeWithExport('top-up exclusions (spec §3)', () => {
  it('Cantina is the only top-up and stays in spend totals', () => {
    expect(topUpIds.size).toBe(1)
    expect(topUpIds.has(idOf('Cantina'))).toBe(true)
    const c = categoryBreakdown(txs).find((x) => x.id === idOf('Cantina'))!
    expect(c.count).toBe(145)
    expect(c.totalMinor).toBe(1531330) // 15,313.30 — the single largest category, kept in every total
    expect(groupBreakdown(txs, categoryById).reduce((s, g) => s + g.totalMinor, 0)).toBe(9609687)
  })
  it('heatmap and leakage leave top-ups out', () => {
    expect(hourWeekdayHeatmap(txs).count.flat().reduce((a, b) => a + b, 0)).toBe(1615)
    expect(hourWeekdayHeatmap(txs, topUpIds).count.flat().reduce((a, b) => a + b, 0)).toBe(1615 - 145)
    const l = smallTicketLeakage(txs, undefined, topUpIds)
    expect(l.reduce((s, m) => s + m.count, 0)).toBe(1470)
  })
  it('ticket stats: small-ticket dataset once card loads are removed', () => {
    const withTopUps = ticketStats(txs)
    const clean = ticketStats(txs, topUpIds)
    expect(withTopUps.count).toBe(1615)
    expect(clean.count).toBe(1470)
    expect(clean.excludedTopUps).toBe(145)
    expect(clean.medianMinor).toBeLessThan(withTopUps.medianMinor)
    expect(clean.medianMinor).toBeLessThan(3000)
    expect(clean.smallShare).toBeGreaterThan(0.5)
  })
})

describeWithExport('capture rate (spec §8.1)', () => {
  const cafe = () => idOf('Café')
  const mk = (date: string, amountMinor: number, extra: Partial<Transaction> = {}): Transaction => ({
    amountMinor,
    currency: 'CNY',
    refAmountMinor: amountMinor,
    fxRate: 1,
    date,
    categoryId: cafe(),
    tags: [],
    source: 'manual',
    createdAt: date,
    ...extra,
  })
  const check = (date: string, countedMinor: number, account = 'Dinheiro'): BalanceCheck => ({ date, account, countedMinor })

  it('one check alone yields nothing', () => {
    expect(captureRates([check('2026-06-01T10:00:00', 100000)], txs)).toEqual([])
  })
  it('two checks give logged / implied', () => {
    const logged = [mk('2026-06-10T12:00:00', -30000), mk('2026-07-10T12:00:00', -58000)]
    const w = captureRates([check('2026-06-01T10:00:00', 200000), check('2026-08-01T10:00:00', 100000)], logged)
    expect(w).toHaveLength(1)
    expect(w[0].impliedSpendMinor).toBe(100000)
    expect(w[0].loggedSpendMinor).toBe(88000)
    expect(w[0].rate).toBeCloseTo(0.88, 6)
    expect(w[0].status).toBe('ok')
  })
  it('income in the window is added to implied spend', () => {
    const logged = [mk('2026-06-10T12:00:00', -50000), mk('2026-06-20T12:00:00', 100000)]
    const w = captureRates([check('2026-06-01T10:00:00', 200000), check('2026-07-01T10:00:00', 250000)], logged)
    // balance rose 500 but 1000 came in → 500 spent; 500 logged → 100%
    expect(w[0].incomeMinor).toBe(100000)
    expect(w[0].impliedSpendMinor).toBe(50000)
    expect(w[0].rate).toBeCloseTo(1, 6)
    expect(w[0].status).toBe('ok')
  })
  it('says "unrecorded income" instead of a nonsense figure', () => {
    const logged = [mk('2026-06-10T12:00:00', -50000)]
    const over = captureRates([check('2026-06-01T10:00:00', 200000), check('2026-07-01T10:00:00', 180000)], logged)
    expect(over[0].rate).toBeGreaterThan(1)
    expect(over[0].status).toBe('unrecorded-income')
    const rose = captureRates([check('2026-06-01T10:00:00', 200000), check('2026-07-01T10:00:00', 260000)], logged)
    expect(rose[0].rate).toBeNull()
    expect(rose[0].status).toBe('unrecorded-income')
  })
  it('pairs consecutive checks per account and ignores boundary transactions correctly', () => {
    const logged = [mk('2026-06-01T10:00:00', -1000), mk('2026-06-15T10:00:00', -2000), mk('2026-07-01T10:00:00', -3000), mk('2026-07-20T10:00:00', -4000)]
    const w = captureRates(
      [check('2026-06-01T10:00:00', 100000), check('2026-07-01T10:00:00', 90000), check('2026-08-01T10:00:00', 80000), check('2026-06-15T00:00:00', 5000, 'Brasil')],
      logged,
    )
    expect(w).toHaveLength(2)
    expect(w[0].loggedSpendMinor).toBe(5000) // (from, to]: excludes the tx at exactly `from`, includes the one at `to`
    expect(w[1].loggedSpendMinor).toBe(4000)
  })
})

describeWithExport('breakdowns', () => {
  it('group shares match the spec concentration table', () => {
    const g = groupBreakdown(txs, categoryById)
    const food = g.find((x) => groupById.get(x.id)!.name === 'Alimentação')!
    const foodIds = new Set([...categoryById.values()].filter((c) => groupById.get(c.groupId)!.name === 'Alimentação').map((c) => c.id!))
    const expected = txs.filter((t) => t.refAmountMinor < 0 && foodIds.has(t.categoryId)).reduce((s, t) => s - t.refAmountMinor, 0)
    expect(food.totalMinor).toBe(expected)
    expect(food.share).toBeCloseTo(0.605, 2) // spec table says 60.9% in mixed nominal units
    expect(g.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 6)
  })
  it('category breakdown ranks Táxi with 149 rows and ~10.3% share', () => {
    const c = categoryBreakdown(txs)
    const taxi = c.find((x) => x.id === idOf('Táxi'))!
    expect(taxi.count).toBe(149)
    expect(taxi.totalMinor).toBe(979503)
    expect(taxi.share).toBeCloseTo(0.103, 2)
    expect(taxi.meanMinor).toBe(Math.round(979503 / 149))
  })
})

describeWithExport('rolling averages & range', () => {
  it('computes average daily spend over trailing windows ending on a given day', () => {
    const last7 = inRange(txs, '2026-04-26', '2026-05-02').reduce((s, t) => (t.refAmountMinor < 0 ? s - t.refAmountMinor : s), 0)
    expect(rollingDailyAverage(txs, 7, '2026-05-02')).toBe(Math.round(last7 / 7))
    expect(rollingDailyAverage(txs, 30, '2026-05-02')).toBeGreaterThan(0)
    expect(rollingDailyAverage(txs, 7, '2025-02-15')).toBe(0) // inside the gap, undeclared → zeros
    expect(rollingDailyAverage(txs, 7, '2025-02-15', untracked)).toBeNull() // declared → no tracked day, no average
    // Window straddling the end of the declared period: only the tracked days form the denominator.
    // (tracking resumed on 2025-05-15; the 30-day window ending 05-20 has 20 tracked days)
    const straddle = rollingDailyAverage(txs, 30, '2025-05-20', untracked)!
    const spend = inRange(txs, '2025-05-01', '2025-05-20').reduce((s, t) => (t.refAmountMinor < 0 ? s - t.refAmountMinor : s), 0)
    expect(spend).toBeGreaterThan(0)
    expect(straddle).toBe(Math.round(spend / 20))
    expect(straddle).toBeGreaterThan(rollingDailyAverage(txs, 30, '2025-05-20')!)
  })
})

describeWithExport('heatmap', () => {
  it('is 7×24 and sums to the expense count', () => {
    const h = hourWeekdayHeatmap(txs)
    expect(h.count).toHaveLength(7)
    expect(h.count[0]).toHaveLength(24)
    expect(h.count.flat().reduce((a, b) => a + b, 0)).toBe(1615)
    expect(h.maxCount).toBeGreaterThan(0)
    // Nothing at 04:00–06:00 on a typical week? Not asserted — just that evenings are busier than dawn.
    const evening = h.count.reduce((s, row) => s + row[19] + row[20] + row[21], 0)
    const dawn = h.count.reduce((s, row) => s + row[4] + row[5] + row[6], 0)
    expect(evening).toBeGreaterThan(dawn)
  })
})

describeWithExport('small-ticket leakage', () => {
  it('about half of all transactions are under 30', () => {
    const l = smallTicketLeakage(txs)
    const small = l.reduce((s, m) => s + m.smallCount, 0)
    const all = l.reduce((s, m) => s + m.count, 0)
    expect(all).toBe(1615)
    expect(small / all).toBeGreaterThan(0.45)
    expect(small / all).toBeLessThan(0.6)
  })
})

describeWithExport('category drift', () => {
  it('compares a month against the trailing 3 complete months', () => {
    const d = categoryDrift(txs, '2026-04')
    expect(d.length).toBeGreaterThan(0)
    for (let i = 1; i < d.length; i++) expect(Math.abs(d[i - 1].deltaMinor)).toBeGreaterThanOrEqual(Math.abs(d[i].deltaMinor))
    const cafe = d.find((x) => x.categoryId === idOf('Café'))!
    const aprCafe = inRange(txs, '2026-04-01', '2026-04-30').filter((t) => t.categoryId === cafe.categoryId).reduce((s, t) => s - t.refAmountMinor, 0)
    expect(cafe.currentMinor).toBe(aprCafe)
    expect(cafe.baselineMinor).toBeGreaterThan(0)
  })
})

describeWithExport('streak', () => {
  it('counts consecutive logged days', () => {
    const s = streak(txs, '2026-05-02')
    expect(s.lastDay).toBe('2026-05-02')
    expect(s.current).toBeGreaterThanOrEqual(1)
    expect(s.longest).toBeGreaterThanOrEqual(s.current)
    expect(streak(txs, '2026-09-09').current).toBe(0) // long gone
    expect(streak([], '2026-09-09')).toEqual({ current: 0, longest: 0, lastDay: null })
  })
})
