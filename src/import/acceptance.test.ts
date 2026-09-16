import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { GastosDB } from '../db/db'
import { importWallet } from './importer'

// The real export is personal data and is not committed; these suites need it and skip without it.
const EXPORT_FILE = resolve(__dirname, '../../fixtures/gastos_report_2026-05-02_203027.csv')
const describeWithExport = existsSync(EXPORT_FILE) ? describe : describe.skip
if (!existsSync(EXPORT_FILE)) console.warn(`skipping ${__filename.split('/').slice(-2).join('/')}: fixture missing`)

// Spec §6 acceptance test, run against the real 3-year export.
// The spec text says 44 categories; the file actually contains 41 distinct
// (envelope_id, category) pairs — the assertion follows the file.
const EXPORT_PATH = resolve(__dirname, '../../fixtures/gastos_report_2026-05-02_203027.csv')

describeWithExport('real Wallet export', () => {
  it('imports 1,617 rows cleanly and re-import is a no-op', async () => {
    const csv = readFileSync(EXPORT_PATH, 'utf-8')
    const db = new GastosDB(`gastos-acceptance-${Date.now()}`)


    const report = await importWallet(db, csv)
    expect(report.errors).toEqual([])
    expect(report.rowsRead).toBe(1617)
    expect(report.imported).toBe(1617)
    expect(report.skipped).toBe(0)
    expect(report.collisions).toEqual([])
    expect(report.unmappedEnvelopes).toEqual([])

    expect(await db.transactions.count()).toBe(1617)
    expect(await db.categories.count()).toBe(41)
    expect(await db.groups.count()).toBe(9)

    const all = await db.transactions.toArray()
    const income = all.filter((t) => t.amountMinor > 0)
    expect(income).toHaveLength(2)
    expect(all.filter((t) => t.currency === 'BRL')).toHaveLength(15)

    // Summed expense total in nominal units: 95,237.34 → 9,523,734 minor units.
    const expenseMinor = all.filter((t) => t.amountMinor < 0).reduce((s, t) => s + t.amountMinor, 0)
    expect(expenseMinor).toBe(-9523734)

    // Every CNY row was already in the reference currency; every BRL row carries its rate.
    for (const t of all) {
      if (t.currency === 'CNY') expect(t.fxRate).toBe(1)
      else expect(t.fxRate).toBeGreaterThan(1)
    }

    // Date range and local-time preservation.
    const dates = all.map((t) => t.date).sort()
    expect(dates[0].startsWith('2023-05-07')).toBe(true)
    expect(dates[dates.length - 1]).toBe('2026-05-02T20:21:39')

    // Notes survive; the structured ones are parsed best-effort.
    expect(all.filter((t) => t.note).length).toBe(58)
    const abacaxi = all.find((t) => t.note?.startsWith('Abacaxi'))!
    expect(abacaxi.item).toBe('Abacaxi')
    expect(abacaxi.qty).toBe(1.47)
    expect(abacaxi.unitPrice).toBe(25.6)

    // Taxonomy: the 8 daily-driver categories all live under Alimentação.
    const alim = await db.groups.where('name').equals('Alimentação').first()
    const food = await db.categories.where('groupId').equals(alim!.id!).toArray()
    const foodNames = food.map((c) => c.name).sort()
    expect(foodNames).toEqual(
      ['Cantina', 'Café', 'Delivery', 'FamilyMart', 'Fora de Casa', 'Johann/Millers', 'Lojinhas', 'Restaurante'].sort(),
    )

    // Spec §3: Cantina is a prepaid top-up (145 rows, the single largest category); nothing else is.
    const cantina = food.find((c) => c.name === 'Cantina')!
    expect(cantina.isTopUp).toBe(1)
    expect(all.filter((t) => t.categoryId === cantina.id)).toHaveLength(145)
    expect((await db.categories.toArray()).filter((c) => c.isTopUp === 1).map((c) => c.name)).toEqual(['Cantina'])

    // Spec §2: payment method is dropped, not stored.
    expect(all.every((t) => !('paymentMethod' in t))).toBe(true)

    // Spec §8: the Jan–Apr 2025 gap is seeded as a declared untracked period, exactly once.
    expect(report.untrackedSeeded).toBe(true)
    const periods = await db.untrackedPeriods.toArray()
    expect(periods).toHaveLength(1)
    expect(periods[0]).toMatchObject({ start: '2025-01-01', end: '2025-04-30' })
    expect(all.some((t) => t.date >= '2025-01-01' && t.date < '2025-05-01')).toBe(false)

    // Idempotent.
    const second = await importWallet(db, csv)
    expect(second.imported).toBe(0)
    expect(second.skipped).toBe(1617)
    expect(second.untrackedSeeded).toBe(false)
    expect(await db.transactions.count()).toBe(1617)
    expect(await db.categories.count()).toBe(41)
    expect(await db.untrackedPeriods.count()).toBe(1)

    // Removing the seeded period is respected by later re-imports.
    await db.untrackedPeriods.clear()
    await importWallet(db, csv)
    expect(await db.untrackedPeriods.count()).toBe(0)
  })
})
