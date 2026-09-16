import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { GastosDB } from '../db/db'
import { importWallet } from '../import/importer'
import { filterTransactions, groupByDay, normalize } from './filter'
import type { Category, Transaction } from '../db/types'

// The real export is personal data and is not committed; these suites need it and skip without it.
const EXPORT_FILE = resolve(__dirname, '../../fixtures/gastos_report_2026-05-02_203027.csv')
const describeWithExport = existsSync(EXPORT_FILE) ? describe : describe.skip
if (!existsSync(EXPORT_FILE)) console.warn(`skipping ${__filename.split('/').slice(-2).join('/')}: fixture missing`)

let txs: Transaction[]
let categoryById: Map<number, Category>
let idOf: (name: string) => number

beforeAll(async () => {
  const csv = readFileSync(resolve(__dirname, '../../fixtures/gastos_report_2026-05-02_203027.csv'), 'utf-8')
  const db = new GastosDB(`gastos-filter-${Date.now()}`)
  await importWallet(db, csv)
  txs = await db.transactions.toArray()
  const cats = await db.categories.toArray()
  categoryById = new Map(cats.map((c) => [c.id!, c]))
  idOf = (name) => cats.find((c) => c.name === name)!.id!
})

describeWithExport('filterTransactions', () => {
  it('normalizes accents and case', () => {
    expect(normalize('Café Táxi ÁLCOOL')).toBe('cafe taxi alcool')
  })

  it('searches notes, items and category names', () => {
    expect(filterTransactions(txs, { query: 'abacaxi' }, categoryById)).toHaveLength(1)
    expect(filterTransactions(txs, { query: 'cafe' }, categoryById).length).toBeGreaterThanOrEqual(166 + 3) // 166 Café rows + "10x Cafe" notes
    expect(filterTransactions(txs, { query: 'sala sao paulo' }, categoryById)).toHaveLength(1)
  })

  it('filters by category, group, date and currency', () => {
    expect(filterTransactions(txs, { categoryIds: [idOf('Táxi')] }, categoryById)).toHaveLength(149)
    const taxiGroup = categoryById.get(idOf('Táxi'))!.groupId
    expect(filterTransactions(txs, { groupIds: [taxiGroup] }, categoryById)).toHaveLength(149 + 33 + 9 + 13 + 1)
    expect(filterTransactions(txs, { fromDay: '2026-05-01', toDay: '2026-05-02' }, categoryById).every((t) => t.date >= '2026-05-01')).toBe(true)
    expect(filterTransactions(txs, { currency: 'BRL' }, categoryById)).toHaveLength(15)
    expect(filterTransactions(txs, { onlyIncome: true }, categoryById)).toHaveLength(2)
  })

  it('combines filters with AND', () => {
    const r = filterTransactions(txs, { categoryIds: [idOf('Café')], fromDay: '2026-05-01', toDay: '2026-05-02' }, categoryById)
    expect(r.every((t) => t.categoryId === idOf('Café') && t.date >= '2026-05-01')).toBe(true)
    expect(r.length).toBeGreaterThan(0)
  })
})

describeWithExport('groupByDay', () => {
  it('groups newest-first with day totals in the reference currency', () => {
    const groups = groupByDay(txs)
    expect(groups[0].day).toBe('2026-05-02')
    expect(groups[0].txs[0].date).toBe('2026-05-02T20:21:39')
    expect(groups[0].totalRefMinor).toBe(groups[0].txs.reduce((s, t) => s + t.refAmountMinor, 0))
    expect(groups.reduce((s, g) => s + g.txs.length, 0)).toBe(txs.length)
    for (let i = 1; i < groups.length; i++) expect(groups[i].day < groups[i - 1].day).toBe(true)
  })
})
