import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { GastosDB } from '../db/db'
import { importWallet } from '../import/importer'
import { rankCategories, coverage } from './ranking'
import { keypadToMinor, minorToKeypad, formatKeypad, formatMinor, convertMinor } from '../lib/money'
import { dayKey, weekdayOf, hourOf, addMonths, formatDay, toLocalIso, fromLocalIso } from '../lib/dates'

// The real export is personal data and is not committed; these suites need it and skip without it.
const EXPORT_FILE = resolve(__dirname, '../../fixtures/gastos_report_2026-05-02_203027.csv')
const describeWithExport = existsSync(EXPORT_FILE) ? describe : describe.skip
if (!existsSync(EXPORT_FILE)) console.warn(`skipping ${__filename.split('/').slice(-2).join('/')}: fixture missing`)

describeWithExport('money helpers', () => {
  it('keypad → minor by string arithmetic', () => {
    expect(keypadToMinor('28.8')).toBe(2880)
    expect(keypadToMinor('4')).toBe(400)
    expect(keypadToMinor('0.29')).toBe(29)
    expect(keypadToMinor('.5')).toBe(50)
    expect(keypadToMinor('')).toBeNull()
    expect(keypadToMinor('.')).toBeNull()
    expect(keypadToMinor('1.234')).toBeNull()
  })
  it('minor → keypad round-trips', () => {
    expect(minorToKeypad(2880)).toBe('28.8')
    expect(minorToKeypad(400)).toBe('4')
    expect(minorToKeypad(-1250)).toBe('12.5')
    expect(minorToKeypad(1205)).toBe('12.05')
  })
  it('formats', () => {
    expect(formatKeypad('')).toBe('0')
    expect(formatKeypad('1234.5')).toBe('1.234,5')
    expect(formatMinor(-9523734)).toBe('-¥95.237,34')
    expect(formatMinor(-2378, 'BRL')).toBe('-R$23,78')
    expect(formatMinor(-2378, 'BRL', { sign: false })).toBe('R$23,78')
  })
  it('converts with a stored rate, rounding away from zero', () => {
    expect(convertMinor(-2378, 1.4592)).toBe(-3470)
    expect(convertMinor(-9750, 1.4591)).toBe(-14226)
  })
})

describeWithExport('date helpers', () => {
  it('never touches UTC', () => {
    const d = new Date(2026, 4, 2, 20, 21, 39)
    expect(toLocalIso(d)).toBe('2026-05-02T20:21:39')
    expect(fromLocalIso('2026-05-02T20:21:39').getHours()).toBe(20)
  })
  it('weekday/hour/month arithmetic', () => {
    expect(weekdayOf('2026-05-02T20:21:39')).toBe(5) // Saturday
    expect(weekdayOf('2026-05-04T08:00:00')).toBe(0) // Monday
    expect(hourOf('2024-06-14T23:00:00')).toBe(23)
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(addMonths('2025-12', 1)).toBe('2026-01')
    expect(dayKey(new Date(2026, 0, 1), -1)).toBe('2025-12-31')
    expect(formatDay('2026-05-02', '2026-05-02')).toBe('Hoje')
    expect(formatDay('2026-05-01', '2026-05-02')).toBe('Ontem')
  })
})

describeWithExport('rankCategories on the real export', () => {
  it('surfaces the 8 daily-driver categories and covers roughly two-thirds of history', async () => {
    const csv = readFileSync(resolve(__dirname, '../../fixtures/gastos_report_2026-05-02_203027.csv'), 'utf-8')
    const db = new GastosDB(`gastos-rank-${Date.now()}`)
    await importWallet(db, csv)
    const txs = await db.transactions.toArray()
    const cats = new Map((await db.categories.toArray()).map((c) => [c.id!, c.name]))

    // Pretend "now" is the day of the export.
    const ranked = rankCategories(txs, { now: new Date(2026, 4, 2, 23, 59, 59) })
    const names = ranked.map((r) => cats.get(r.categoryId))
    expect(names).toHaveLength(8)
    // Rolling 90-day window as of the export date (Feb–May 2026): the pad reflects *current* habits,
    // which is why Fora de Casa / Lojinhas (big all-time, dormant lately) don't make the cut.
    expect(names.slice(0, 2)).toEqual(['Café', 'FamilyMart'])
    expect(names.slice(2, 4).sort()).toEqual(['Cantina', 'Táxi']) // tied at 30 in-window
    for (const n of ['Restaurante', 'Delivery', 'Lavanderia']) expect(names).toContain(n)

    // Still covers most of the recent window.
    const recent = txs.filter((t) => t.date >= '2026-02-01')
    expect(coverage(recent, ranked.map((r) => r.categoryId))).toBeGreaterThan(0.8)

    // Quick-repeat data is the most recent amount for that category.
    const cafe = ranked.find((r) => cats.get(r.categoryId) === 'Café')!
    expect(cafe.lastAmountMinor).toBe(-1880) // 2026-05-02 14:46:26 Café -18,80
    expect(cafe.lastCurrency).toBe('CNY')
  })

  it('backfills from all-time when the 90-day window is empty', () => {
    const mk = (categoryId: number, date: string) => ({
      amountMinor: -100,
      currency: 'CNY',
      refAmountMinor: -100,
      fxRate: 1,
      date,
      categoryId,
      tags: [],
      source: 'manual' as const,
      createdAt: date,
    })
    const txs = [mk(1, '2024-01-01T10:00:00'), mk(1, '2024-01-02T10:00:00'), mk(2, '2024-01-03T10:00:00'), mk(3, '2026-09-01T10:00:00')]
    const r = rankCategories(txs, { now: new Date(2026, 8, 9) })
    expect(r.map((x) => x.categoryId)).toEqual([3, 1, 2])
  })
})
