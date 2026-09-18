import { describe, it, expect } from 'vitest'
import { runsOf } from './CoveragePanel'
import type { MonthStat } from './engine'

const m = (month: string, count: number): MonthStat => ({
  month,
  count,
  totalMinor: count * 1000,
  coverage: 'incomplete',
  incomplete: true,
  untrackedDays: 0,
  daysInMonth: 30,
  trailingMedianCount: 80,
  topCategories: [],
})

describe('runsOf — which suspected months may be declared together', () => {
  it('collapses a stretch of wholly empty months into one row', () => {
    const r = runsOf([m('2023-06', 0), m('2023-07', 0), m('2023-08', 0)])
    expect(r).toHaveLength(1)
    expect([r[0].start, r[0].end]).toEqual(['2023-06', '2023-08'])
    expect(r[0].months).toHaveLength(3)
  })

  it('never merges a month that holds transactions — one tap must not hide real spending', () => {
    // Felipe's live shape after the Aug–Sep import: May partial, Jun/Jul empty, Aug partial.
    const r = runsOf([m('2026-05', 12), m('2026-06', 0), m('2026-07', 0), m('2026-08', 32)])
    expect(r.map((x) => [x.start, x.end, x.count])).toEqual([
      ['2026-05', '2026-05', 12],
      ['2026-06', '2026-07', 0],
      ['2026-08', '2026-08', 32],
    ])
    // The important property: no run both starts before August and covers it.
    const augRun = r.find((x) => x.start <= '2026-08' && x.end >= '2026-08')!
    expect(augRun.start).toBe('2026-08')
    expect(augRun.count).toBe(32)
  })

  it('keeps two adjacent thin months separate so each is judged on its own', () => {
    const r = runsOf([m('2024-06', 3), m('2024-07', 2)])
    expect(r).toHaveLength(2)
  })

  it('does not merge across a non-consecutive gap', () => {
    const r = runsOf([m('2024-06', 0), m('2024-09', 0)])
    expect(r).toHaveLength(2)
  })
})
