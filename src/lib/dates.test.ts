import { describe, it, expect } from 'vitest'
import { dayKey, msUntilNextDay } from './dates'

describe('msUntilNextDay', () => {
  it('lands just past the next local midnight', () => {
    const now = new Date(2026, 9, 18, 23, 59, 30)
    const ms = msUntilNextDay(now)
    expect(ms).toBe(31_000)
    expect(dayKey(new Date(now.getTime() + ms))).toBe('2026-10-19')
  })

  it('works across a month end and from just after midnight', () => {
    expect(dayKey(new Date(new Date(2026, 9, 31, 12).getTime() + msUntilNextDay(new Date(2026, 9, 31, 12))))).toBe('2026-11-01')
    expect(msUntilNextDay(new Date(2026, 9, 18, 0, 0, 0))).toBe(24 * 3600_000 + 1000)
  })
})
