import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Papa from 'papaparse'
import { GastosDB } from '../db/db'
import { importWallet } from '../import/importer'
import type { Category, Group, Tag, Transaction, UntrackedPeriod } from '../db/types'
import { buildCompactCsv, buildFullCsv, buildMarkdownBundle, decimal, type ExportTaxonomy } from './bundle'
import { buildBackup, parseBackup, restoreBackup } from './backup'

// The real export is personal data and is not committed; these suites need it and skip without it.
const EXPORT_FILE = resolve(__dirname, '../../fixtures/gastos_report_2026-05-02_203027.csv')
const describeWithExport = existsSync(EXPORT_FILE) ? describe : describe.skip
if (!existsSync(EXPORT_FILE)) console.warn(`skipping ${__filename.split('/').slice(-2).join('/')}: fixture missing`)

let db: GastosDB
let txs: Transaction[]
let tax: ExportTaxonomy
let untracked: UntrackedPeriod[]

beforeAll(async () => {
  const csv = readFileSync(resolve(__dirname, '../../fixtures/gastos_report_2026-05-02_203027.csv'), 'utf-8')
  db = new GastosDB(`gastos-export-${Date.now()}`)
  await importWallet(db, csv)
  txs = await db.transactions.toArray()
  untracked = await db.untrackedPeriods.toArray()
  tax = {
    categoryById: new Map((await db.categories.toArray()).map((c: Category) => [c.id!, c])),
    groupById: new Map((await db.groups.toArray()).map((g: Group) => [g.id!, g])),
    tagById: new Map((await db.tags.toArray()).map((t: Tag) => [t.id!, t])),
  }
})

describeWithExport('decimal', () => {
  it('formats minor units with a point and no separators', () => {
    expect(decimal(-14100)).toBe('-141.00')
    expect(decimal(2880)).toBe('28.80')
    expect(decimal(-9523734)).toBe('-95237.34')
    expect(decimal(5)).toBe('0.05')
  })
})

describeWithExport('markdown bundle', () => {
  it('has the four sections and is self-describing', () => {
    const md = buildMarkdownBundle(txs, tax, { fromDay: '2025-05-01', toDay: '2026-05-02', refCurrency: 'CNY', generatedAt: '2026-09-09T12:00:00' })
    expect(md).toContain('## 1. Schema')
    expect(md).toContain('## 2. Monthly rollup')
    expect(md).toContain('## 3. Category rollup')
    expect(md).toContain('## 4. Transactions')
    // schema note is exactly five bullet lines
    const schema = md.split('## 2.')[0].split('\n').filter((l) => l.startsWith('- '))
    expect(schema).toHaveLength(5)
    expect(md).toContain('**CNY**')
    // monthly table lists every month in range with a coverage flag
    expect(md).toMatch(/\| 2026-04 \| \d+ \| \d+\.\d{2} \| .+ \| ok \|/)
    expect(md).toMatch(/\| 2026-05 \| \d+ \| \d+\.\d{2} \| .+ \| incomplete \|/)
    // category table mentions group and share; top-ups are labelled
    expect(md).toMatch(/\| Café \| Alimentação \| \d+ \| \d+\.\d{2} \| \d+\.\d% \| \d+\.\d{2} \|/)
    expect(md).toMatch(/\| Cantina \(top-up\) \| Alimentação \| \d+ \|/)
    expect(md).toContain('**Top-up categories** (Cantina)')
  })

  it('tells the two coverage flavours apart (spec §8)', () => {
    const opts = { fromDay: '2024-01-01', toDay: '2026-05-02', refCurrency: 'CNY', generatedAt: '2026-09-09T12:00:00' }
    const withPeriods = buildMarkdownBundle(txs, tax, { ...opts, untracked })
    expect(withPeriods).toContain('**untracked** months (2025-01, 2025-02, 2025-03, 2025-04)')
    expect(withPeriods).toContain('**incomplete** months (2024-06, 2024-07')
    expect(withPeriods).toMatch(/\| 2025-02 \| 0 \| 0\.00 \| — \| untracked \|/)
    expect(withPeriods).toMatch(/\| 2024-06 \| \d \| \d+\.\d{2} \| .+ \| incomplete \|/)
    // still exactly five schema bullets
    expect(withPeriods.split('## 2.')[0].split('\n').filter((l) => l.startsWith('- '))).toHaveLength(5)
    // without declared periods the same months fall back to "incomplete"
    const without = buildMarkdownBundle(txs, tax, opts)
    expect(without).not.toContain('**untracked**')
    expect(without).toMatch(/\| 2025-02 \| 0 \| 0\.00 \| — \| incomplete \|/)
  })

  it('embeds a compact CSV that a parser reads back with ISO dates and decimal points', () => {
    const md = buildMarkdownBundle(txs, tax, { fromDay: '2025-06-01', toDay: '2026-05-02', refCurrency: 'CNY', generatedAt: '2026-09-09T12:00:00' })
    const csv = md.split('```csv\n')[1].split('\n```')[0]
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true })
    expect(parsed.errors).toEqual([])
    const rows = parsed.data
    expect(rows.length).toBe(txs.filter((t) => t.date >= '2025-06-01' && t.date <= '2026-05-02T23:59:59').length)
    expect(parsed.meta.fields).toEqual(['date', 'amount', 'currency', 'category', 'group', 'note']) // no tags → column dropped
    expect(rows[rows.length - 1].date).toBe('2026-05-02T20:21:39')
    expect(rows[rows.length - 1].amount).toBe('-141.00')
    expect(rows.every((r) => /^-?\d+\.\d{2}$/.test(r.amount))).toBe(true)
    // notes with commas are quoted correctly
    const abacaxi = rows.find((r) => r.note.startsWith('Abacaxi'))
    expect(abacaxi?.note).toBe('Abacaxi, 1.47kg, 25.60元/kg')
  })

  it('keeps the tags column when any row has tags', async () => {
    const tagId = (await db.tags.toArray())[0].id!
    const extra: Transaction = { ...txs[0], id: undefined, tags: [tagId] }
    const csv = buildCompactCsv([extra, txs[1]], tax)
    expect(csv.split('\n')[0]).toBe('date,amount,currency,category,group,tags')
  })

  it('full CSV carries every field (and no payment method)', () => {
    const csv = buildFullCsv(txs.slice(0, 3), tax)
    expect(csv.split('\n')[0]).toContain('ref_amount')
    expect(csv.split('\n')[0]).toContain('top_up')
    expect(csv.split('\n')[0]).not.toContain('payment')
    expect(csv.split('\n')).toHaveLength(4)
  })
})

describeWithExport('backup & restore', () => {
  it('round-trips with replace', async () => {
    const b = await buildBackup(db, '2026-09-09T12:00:00')
    const text = JSON.stringify(b)
    const parsed = parseBackup(text)
    const target = new GastosDB(`gastos-restore-${Date.now()}`)
    expect(b.version).toBe(2)
    expect(b.untrackedPeriods).toHaveLength(1)
    const r = await restoreBackup(target, parsed, 'replace')
    expect(r.transactions).toBe(1617)
    expect(r.untrackedPeriods).toBe(1)
    expect(await target.transactions.count()).toBe(1617)
    expect(await target.categories.count()).toBe(41)
    expect(await target.groups.count()).toBe(9)
    expect(await target.untrackedPeriods.count()).toBe(1)
    expect((await target.categories.where('name').equals('Cantina').first())!.isTopUp).toBe(1)
    const a = (await target.transactions.orderBy('date').last())!
    expect(a.date).toBe('2026-05-02T20:21:39')
    expect(a.amountMinor).toBe(-14100)
  })

  it('merge adds only what is missing and remaps taxonomy ids by name', async () => {
    // Target DB has a manual entry in a category whose id differs from the backup's.
    const target = new GastosDB(`gastos-merge-${Date.now()}`)
    await importWallet(target, readFileSync(resolve(__dirname, '../../fixtures/gastos_report_2026-05-02_203027.csv'), 'utf-8'))
    // Source DB: the same import plus a manual entry
    const source = new GastosDB(`gastos-merge-src-${Date.now()}`)
    await importWallet(source, readFileSync(resolve(__dirname, '../../fixtures/gastos_report_2026-05-02_203027.csv'), 'utf-8'))
    const cafe = (await source.categories.where('name').equals('Café').first())!
    // Use the source db for addTransaction by temporarily pointing at it
    await source.transactions.add({
      amountMinor: -1880,
      currency: 'CNY',
      refAmountMinor: -1880,
      fxRate: 1,
      date: '2026-09-09T09:30:00',
      categoryId: cafe.id!,
      tags: [],
      source: 'manual',
      createdAt: '2026-09-09T09:30:05',
    })
    const b = await buildBackup(source, '2026-09-09T12:00:00')
    const r = await restoreBackup(target, b, 'merge')
    expect(r.skipped).toBe(1617)
    expect(r.transactions).toBe(1)
    expect(await target.transactions.count()).toBe(1618)
    const added = (await target.transactions.where('date').equals('2026-09-09T09:30:00').first())!
    const targetCafe = (await target.categories.where('name').equals('Café').first())!
    expect(added.categoryId).toBe(targetCafe.id)
    // merging again is a no-op
    const r2 = await restoreBackup(target, b, 'merge')
    expect(r2.transactions).toBe(0)
    expect(await target.transactions.count()).toBe(1618)
  })


  it('reads a v1 (phase-6) backup: drops paymentMethod, derives isTopUp, fills the new tables', async () => {
    const v1 = {
      format: 'gastos-backup',
      version: 1,
      exportedAt: '2026-09-09T16:00:00',
      groups: [{ id: 1, name: 'Alimentação', color: '#d95926', sortOrder: 0, kind: 'expense' }],
      categories: [
        { id: 1, groupId: 1, name: 'Cantina', archived: 0 },
        { id: 2, groupId: 1, name: 'Café', archived: 0 },
      ],
      tags: [],
      transactions: [
        { id: 1, amountMinor: -20000, currency: 'CNY', refAmountMinor: -20000, fxRate: 1, date: '2026-04-01T18:09:00', categoryId: 1, tags: [], paymentMethod: 'wechat', source: 'manual', createdAt: '2026-04-01T18:09:05' },
      ],
      settings: [
        { key: 'refCurrency', value: 'CNY' },
        { key: 'defaultPaymentMethod', value: 'wechat' },
      ],
    }
    const parsed = parseBackup(JSON.stringify(v1))
    expect(parsed.version).toBe(2)
    expect(parsed.untrackedPeriods).toEqual([])
    expect(parsed.balanceChecks).toEqual([])
    expect(parsed.categories.map((c) => c.isTopUp)).toEqual([1, 0])
    expect('paymentMethod' in parsed.transactions[0]).toBe(false)
    expect(parsed.settings.map((s) => s.key)).toEqual(['refCurrency'])
    const target = new GastosDB(`gastos-restore-v1-${Date.now()}`)
    const r = await restoreBackup(target, parsed, 'replace')
    expect(r.transactions).toBe(1)
    expect((await target.categories.get(1))!.isTopUp).toBe(1)
  })

  it('merge carries untracked periods and balance checks without duplicating them', async () => {
    const target = new GastosDB(`gastos-merge2-${Date.now()}`)
    await importWallet(target, readFileSync(resolve(__dirname, '../../fixtures/gastos_report_2026-05-02_203027.csv'), 'utf-8'))
    await db.balanceChecks.add({ date: '2026-06-01T10:00:00', account: 'Dinheiro', countedMinor: 120000 })
    const b = await buildBackup(db, '2026-09-09T12:00:00')
    const r = await restoreBackup(target, b, 'merge')
    expect(r.untrackedPeriods).toBe(0) // the seeded period already exists in the target
    expect(r.balanceChecks).toBe(1)
    const r2 = await restoreBackup(target, b, 'merge')
    expect(r2.balanceChecks).toBe(0)
    expect(await target.balanceChecks.count()).toBe(1)
    expect(await target.untrackedPeriods.count()).toBe(1)
  })

  it('rejects foreign JSON', () => {
    expect(() => parseBackup('{"hello":1}')).toThrow()
  })
})

