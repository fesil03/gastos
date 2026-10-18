import { describe, it, expect } from 'vitest'
import type { Transaction, UntrackedPeriod } from '../db/types'
import { monthBounds } from '../lib/dates'
import { monthlyStats } from './engine'
import { LARGE_FLOOR_MINOR, budgetGuidance, largeThreshold, projectMonth, suggestBudget } from './projection'

// Synthetic history: every day ¥50 of everyday spend, rent ¥3,000 on the 1st, a ¥500 campus-card
// top-up on the 15th. Small enough to check every number by hand.
const EVERYDAY = 1
const RENT = 2
const CANTINA = 9 // top-up category
const topUpIds = new Set([CANTINA])

let seq = 0
function tx(day: string, yuan: number, categoryId = EVERYDAY): Transaction {
  const minor = Math.round(yuan * 100)
  return {
    id: ++seq,
    amountMinor: -minor,
    currency: 'CNY',
    refAmountMinor: -minor,
    fxRate: 1,
    date: `${day}T12:00:00`,
    categoryId,
    tags: [],
    source: 'manual',
    createdAt: `${day}T12:00:00`,
  }
}

function typicalMonth(month: string, daily = 50): Transaction[] {
  const last = Number(monthBounds(month)[1].slice(8, 10))
  const out: Transaction[] = [tx(`${month}-01`, 3000, RENT), tx(`${month}-15`, 500, CANTINA)]
  for (let d = 1; d <= last; d++) out.push(tx(`${month}-${String(d).padStart(2, '0')}`, daily))
  return out
}

const HISTORY = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].flatMap((m) => typicalMonth(m))

/** October so far: rent on the 1st, ¥60 a day through the 10th. */
function octoberTo10(): Transaction[] {
  const out = [tx('2026-10-01', 3000, RENT)]
  for (let d = 1; d <= 10; d++) out.push(tx(`2026-10-${String(d).padStart(2, '0')}`, 60))
  return out
}

describe('largeThreshold', () => {
  it('never drops below the floor, and leaves top-ups out of the ticket distribution', () => {
    expect(largeThreshold(HISTORY, ['2026-08', '2026-09'], topUpIds)).toBe(LARGE_FLOOR_MINOR)
    expect(largeThreshold(HISTORY, [], topUpIds)).toBe(LARGE_FLOOR_MINOR)
  })

  it('rises to the 95th percentile when tickets are larger than the floor', () => {
    const big = Array.from({ length: 20 }, (_, i) => tx(`2026-09-${String(i + 1).padStart(2, '0')}`, 100 + i * 10))
    // 20 tickets ¥100..¥290; nearest-rank P95 = 19th = ¥280
    expect(largeThreshold(big, ['2026-09'])).toBe(28_000)
  })
})

describe('projectMonth', () => {
  const txs = [...HISTORY, ...octoberTo10()]
  const p = projectMonth(txs, { month: '2026-10', asOf: '2026-10-10', topUpIds })

  it('counts days and splits everyday from one-off spend', () => {
    expect(p.daysInMonth).toBe(31)
    expect(p.elapsedDays).toBe(10)
    expect(p.remainingDays).toBe(21)
    expect(p.spentMinor).toBe(360_000)
    expect(p.spentTodayMinor).toBe(6_000)
    expect(p.everydayMinor).toBe(60_000)
    expect(p.lumpyMinor).toBe(300_000) // rent is a one-off, not a daily habit
    expect(p.lumpyCount).toBe(1)
  })

  it('pace extrapolates only the everyday rate — rent is counted once', () => {
    expect(p.currentDailyMinor).toBe(6_000)
    expect(p.paceMinor).toBe(360_000 + 6_000 * 21)
  })

  it('trend blends the rate with the last three months and adds the large spends still to come', () => {
    expect(p.method).toBe('trend')
    expect(p.baselineMonths).toEqual(['2026-07', '2026-08', '2026-09'])
    expect(p.baselineDailyMinor).toBe(5_000)
    expect(p.baselineLumpyMinor).toBe(350_000) // rent + top-up
    expect(p.currentWeight).toBeCloseTo(10 / 17)
    // Rent is already paid; of the usual ¥3,500 in lumps only the ¥500 top-up is still ahead.
    expect(p.expectedLumpyRemainingMinor).toBe(50_000)
    const blended = (10 / 17) * 6_000 + (7 / 17) * 5_000
    expect(p.projectedMinor).toBe(360_000 + Math.round(blended * 21) + 50_000)
  })

  it('backtests against past months and reports the band (exact history → zero error)', () => {
    expect(p.band).not.toBeNull()
    expect(p.band!.samples).toBe(5) // April has no history of its own, so it can't be backtested
    expect(p.band!.typicalError).toBe(0)
    expect(p.band!.lowMinor).toBe(p.projectedMinor)
    expect(p.band!.highMinor).toBe(p.projectedMinor)
  })

  it('a noisier history widens the band', () => {
    const noisy = [
      ...typicalMonth('2026-04', 50),
      ...typicalMonth('2026-05', 80),
      ...typicalMonth('2026-06', 40),
      ...typicalMonth('2026-07', 70),
      ...typicalMonth('2026-08', 45),
      ...typicalMonth('2026-09', 75),
      ...octoberTo10(),
    ]
    const q = projectMonth(noisy, { month: '2026-10', asOf: '2026-10-10', topUpIds })
    expect(q.band!.typicalError).toBeGreaterThan(0.01)
    expect(q.band!.lowMinor).toBeLessThan(q.projectedMinor)
    expect(q.band!.highMinor).toBeGreaterThan(q.projectedMinor)
    expect(q.band!.lowMinor).toBeGreaterThanOrEqual(q.spentMinor)
  })

  it('without history falls back to pace, with no band', () => {
    const q = projectMonth(octoberTo10(), { month: '2026-10', asOf: '2026-10-10', topUpIds })
    expect(q.method).toBe('pace')
    expect(q.projectedMinor).toBe(q.paceMinor)
    expect(q.band).toBeNull()
  })

  it('on day 1 with nothing logged it leans almost entirely on history', () => {
    const q = projectMonth(HISTORY, { month: '2026-10', asOf: '2026-10-01', topUpIds })
    expect(q.spentMinor).toBe(0)
    expect(q.method).toBe('trend')
    // ¥0 today pulls the rate down a little (weight 1/8); the usual lumps all lie ahead.
    expect(q.expectedLumpyRemainingMinor).toBe(Math.round(Math.min((350_000 * 30) / 31, 350_000)))
    expect(q.projectedMinor).toBeGreaterThan(400_000)
    expect(q.projectedMinor).toBeLessThan(500_000)
  })

  it('treats a top-up as lumpy even when it is small', () => {
    const q = projectMonth([...HISTORY, ...octoberTo10(), tx('2026-10-05', 100, CANTINA)], { month: '2026-10', asOf: '2026-10-10', topUpIds })
    expect(q.everydayMinor).toBe(60_000)
    expect(q.lumpyMinor).toBe(310_000)
  })

  it('counts a row already entered for later this month once, without extrapolating it', () => {
    const q = projectMonth([...octoberTo10(), tx('2026-10-25', 800)], { month: '2026-10', asOf: '2026-10-10' })
    expect(q.scheduledMinor).toBe(80_000)
    expect(q.spentMinor).toBe(360_000)
    expect(q.paceMinor).toBe(360_000 + 80_000 + 6_000 * 21)
  })

  it('takes declared untracked days out of both elapsed and remaining days', () => {
    const untracked: UntrackedPeriod[] = [
      { start: '2026-10-05', end: '2026-10-07' },
      { start: '2026-10-20', end: '2026-10-21' },
    ]
    const q = projectMonth(octoberTo10(), { month: '2026-10', asOf: '2026-10-10', untracked })
    expect(q.trackedDays).toBe(26)
    expect(q.elapsedDays).toBe(7)
    expect(q.remainingDays).toBe(19)
  })

  it('on the last day there is nothing left to project', () => {
    const q = projectMonth(typicalMonth('2026-10'), { month: '2026-10', asOf: '2026-10-31' })
    expect(q.remainingDays).toBe(0)
    expect(q.projectedMinor).toBe(q.spentMinor)
  })

  it('ignores income rows', () => {
    const income: Transaction = { ...tx('2026-10-03', 0), amountMinor: 900_000, refAmountMinor: 900_000 }
    const q = projectMonth([...octoberTo10(), income], { month: '2026-10', asOf: '2026-10-10' })
    expect(q.spentMinor).toBe(360_000)
  })

  it('one exceptional purchase in a past month does not inflate what later months expect', () => {
    // A ¥5,000 flight in August. With a mean, October would expect ~¥1,700 more in large spends.
    const withFlight = [...HISTORY, tx('2026-08-20', 5000, EVERYDAY), ...octoberTo10()]
    const q = projectMonth(withFlight, { month: '2026-10', asOf: '2026-10-10', topUpIds })
    expect(q.baselineLumpyMinor).toBe(350_000)
    expect(q.expectedLumpyRemainingMinor).toBe(50_000)
    expect(q.projectedMinor).toBe(p.projectedMinor)
  })

  it('never uses a suspected-lapse month as history', () => {
    // September logged only three days: incomplete, so it must not drag the baseline down.
    const sparse = [...HISTORY.filter((t) => !t.date.startsWith('2026-09')), tx('2026-09-02', 50), tx('2026-09-03', 50), tx('2026-09-04', 50)]
    const stats = monthlyStats(sparse)
    expect(stats.find((m) => m.month === '2026-09')!.coverage).toBe('incomplete')
    const q = projectMonth([...sparse, ...octoberTo10()], { month: '2026-10', asOf: '2026-10-10', topUpIds })
    expect(q.baselineMonths).toEqual(['2026-06', '2026-07', '2026-08'])
  })
})

describe('budgetGuidance', () => {
  const txs = [...HISTORY, ...octoberTo10()]
  const p = projectMonth(txs, { month: '2026-10', asOf: '2026-10-10', topUpIds })

  it('spreads what is left over the days left, holding back the large spends still expected', () => {
    const g = budgetGuidance(p, 500_000)
    expect(g.spentMinor).toBe(360_000)
    expect(g.remainingMinor).toBe(140_000)
    expect(g.daysLeft).toBe(22) // today + 21
    expect(g.reservedMinor).toBe(50_000)
    // start of today: 354,000 spent; 500,000 − 354,000 − 50,000 = 96,000 over 22 days
    expect(g.dailyAllowanceMinor).toBe(Math.floor(96_000 / 22))
    expect(g.expectedByNowMinor).toBe(Math.round((500_000 * 10) / 31))
  })

  it('flags a month heading over budget, then one already over', () => {
    expect(budgetGuidance(p, 500_000).status).toBe('over-projected')
    expect(budgetGuidance(p, 500_000).projectedOverMinor).toBe(p.projectedMinor - 500_000)
    expect(budgetGuidance(p, 300_000).status).toBe('over')
    expect(budgetGuidance(p, 300_000).dailyAllowanceMinor).toBe(0)
    expect(budgetGuidance(p, 560_000).status).toBe('tight')
    expect(budgetGuidance(p, 800_000).status).toBe('ok')
  })

  it('has no allowance once the month has no days left', () => {
    const q = projectMonth(typicalMonth('2026-10'), { month: '2026-10', asOf: '2026-10-31' })
    const g = budgetGuidance({ ...q, asOfTracked: false }, 1_000_000)
    expect(g.daysLeft).toBe(0)
    expect(g.dailyAllowanceMinor).toBeNull()
  })
})

describe('suggestBudget', () => {
  it('is the median of recent full months, rounded to 100', () => {
    const stats = monthlyStats(HISTORY)
    // 30-day months: 1,500 + 3,500 = 5,000; 31-day: 5,050 → median of six = 5,025 → 5,000 (to nearest 100)
    expect(suggestBudget(stats, '2026-10')).toBe(500_000)
    expect(suggestBudget(stats, '2026-04')).toBeNull()
  })
})
