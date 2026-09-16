import { describe, it, expect, beforeEach } from 'vitest'
import { GastosDB } from '../db/db'
import { parseWalletCsv, parseAmountMinor, parseWalletDate, parseStructuredNote, externalHash } from './wallet'
import { importWallet } from './importer'

// Real rows from the export — spec §11.
const HEADER =
  'account;category;currency;amount;ref_currency_amount;type;payment_type;payment_type_local;note;date;gps_latitude;gps_longitude;gps_accuracy_in_meters;warranty_in_month;transfer;payee;labels;envelope_id;custom_category'
const ROW_PRESENTES =
  'Dinheiro;Presentes, alegrias;CNY;-141,00;-141,00;Despesas;CASH;Dinheiro;;2026-05-02 20:21:39;;;;0;false;;;2007;false'
const ROW_CAFE = 'Dinheiro;Café;CNY;-4,00;-4,00;Despesas;CASH;Dinheiro;;2026-05-01 13:49:49;;;;0;false;;;1000;true'
const ROW_BRL =
  'Brasil;Cultura, eventos esportivos;BRL;-23,78;-34,70;Despesas;CASH;Dinheiro;Sala Sao Paulo;2024-06-14 23:00:00;;;;0;false;;;6003;false'
const FIXTURE = [HEADER, ROW_PRESENTES, ROW_CAFE, ROW_BRL].join('\n')

let dbCounter = 0
function freshDb() {
  return new GastosDB(`gastos-test-${Date.now()}-${dbCounter++}`)
}

describe('primitives', () => {
  it('parses Portuguese decimals into signed minor units', () => {
    expect(parseAmountMinor('-141,00')).toBe(-14100)
    expect(parseAmountMinor('-4,00')).toBe(-400)
    expect(parseAmountMinor('683,00')).toBe(68300)
    expect(parseAmountMinor('-23,78')).toBe(-2378)
    expect(parseAmountMinor('1.234,56')).toBe(123456) // thousands separator, defensively
    expect(parseAmountMinor('-0,1')).toBe(-10)
    expect(parseAmountMinor('')).toBeNull()
    expect(parseAmountMinor('abc')).toBeNull()
  })

  it('never goes through float rounding traps', () => {
    // 0.29 * 100 = 28.999999999999996 in IEEE 754; string arithmetic must give 29.
    expect(parseAmountMinor('0,29')).toBe(29)
    expect(parseAmountMinor('-1,15')).toBe(-115)
  })

  it('converts Wallet dates to local naive ISO without touching the clock', () => {
    expect(parseWalletDate('2026-05-02 20:21:39')).toBe('2026-05-02T20:21:39')
    expect(parseWalletDate('2024-06-14 23:00:00')).toBe('2024-06-14T23:00:00')
    expect(parseWalletDate('garbage')).toBeNull()
  })

  it('parses the structured note best-effort', () => {
    expect(parseStructuredNote('Abacaxi, 1.47kg, 25.60元/kg')).toEqual({
      item: 'Abacaxi',
      qty: 1.47,
      unitPrice: 25.6,
    })
    expect(parseStructuredNote('10x Cafe')).toEqual({ item: 'Cafe', qty: 10 })
    expect(parseStructuredNote('Sala Sao Paulo')).toEqual({})
    expect(parseStructuredNote('')).toEqual({})
  })

  it('hashes deterministically from date + amount + currency + category', async () => {
    const a = await externalHash('2026-05-02T20:21:39', -14100, 'CNY', 'Presentes, alegrias')
    const b = await externalHash('2026-05-02T20:21:39', -14100, 'CNY', 'Presentes, alegrias')
    const c = await externalHash('2026-05-02T20:21:39', -14100, 'CNY', 'Café')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('parseWalletCsv', () => {
  it('reads semicolon-delimited rows into typed records', () => {
    const { rows, errors } = parseWalletCsv(FIXTURE)
    expect(errors).toEqual([])
    expect(rows).toHaveLength(3)

    const [presentes, cafe, brl] = rows
    expect(presentes.amountMinor).toBe(-14100) // sign preserved
    expect(presentes.refAmountMinor).toBe(-14100)
    expect(presentes.currency).toBe('CNY')
    expect(presentes.category).toBe('Presentes, alegrias')
    expect(presentes.envelopeId).toBe(2007)
    expect(presentes.customCategory).toBe(false)
    expect(presentes.date).toBe('2026-05-02T20:21:39')
    expect('paymentMethod' in presentes).toBe(false) // payment method is not tracked (spec §2)
    expect(presentes.note).toBeUndefined()

    expect(cafe.amountMinor).toBe(-400)
    expect(cafe.customCategory).toBe(true)

    expect(brl.currency).toBe('BRL')
    expect(brl.amountMinor).toBe(-2378)
    expect(brl.refAmountMinor).toBe(-3470)
    expect(brl.fxRate).toBeCloseTo(1.4592, 3)
    expect(brl.note).toBe('Sala Sao Paulo')
  })

  it('tolerates quoted fields containing the delimiter', () => {
    const quoted = HEADER + '\n' + 'Dinheiro;"Café";CNY;-4,00;-4,00;Despesas;CASH;Dinheiro;"a; b";2026-05-01 13:49:49;;;;0;false;;;1000;true'
    const { rows, errors } = parseWalletCsv(quoted)
    expect(errors).toEqual([])
    expect(rows[0].note).toBe('a; b')
  })

  it('reports malformed rows instead of throwing', () => {
    const bad = HEADER + '\n' + 'Dinheiro;Café;CNY;not-a-number;-4,00;Despesas;CASH;Dinheiro;;2026-05-01 13:49:49;;;;0;false;;;1000;true'
    const { rows, errors } = parseWalletCsv(bad)
    expect(rows).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0].line).toBe(2)
  })
})

describe('importWallet (fixture)', () => {
  let db: GastosDB
  beforeEach(() => {
    db = freshDb()
  })

  it('imports the three fixture rows with the right taxonomy', async () => {
    const report = await importWallet(db, FIXTURE)
    expect(report.rowsRead).toBe(3)
    expect(report.imported).toBe(3)
    expect(report.skipped).toBe(0)
    expect(report.unmappedEnvelopes).toEqual([])

    const txs = await db.transactions.orderBy('date').toArray()
    expect(txs).toHaveLength(3)

    const brl = txs.find((t) => t.currency === 'BRL')!
    expect(brl.amountMinor).toBe(-2378)
    expect(brl.fxRate).toBeCloseTo(1.4592, 3)
    expect(brl.note).toBe('Sala Sao Paulo')
    expect(brl.source).toBe('wallet-import')
    expect(brl.externalHash).toMatch(/^[0-9a-f]{64}$/)

    // custom_category=true on Café → a category under Alimentação, not a new group
    const cafe = await db.categories.where('name').equals('Café').first()
    expect(cafe).toBeDefined()
    const group = await db.groups.get(cafe!.groupId)
    expect(group!.name).toBe('Alimentação')
    expect(cafe!.walletCustom).toBe(true)
    expect(await db.groups.count()).toBe(9) // no group was invented

    const presentes = await db.categories.where('name').equals('Presentes, alegrias').first()
    expect((await db.groups.get(presentes!.groupId))!.name).toBe('Compras')
    const cultura = await db.categories.where('name').equals('Cultura, eventos esportivos').first()
    expect((await db.groups.get(cultura!.groupId))!.name).toBe('Vida & Lazer')
  })

  it('is idempotent — the second run adds nothing', async () => {
    await importWallet(db, FIXTURE)
    const second = await importWallet(db, FIXTURE)
    expect(second.rowsRead).toBe(3)
    expect(second.imported).toBe(0)
    expect(second.skipped).toBe(3)
    expect(await db.transactions.count()).toBe(3)
    expect(await db.categories.count()).toBe(3)
  })

  it('imports newer rows from a superset export without duplicating old ones', async () => {
    await importWallet(db, FIXTURE)
    const newer = FIXTURE + '\n' + 'Dinheiro;Táxi;CNY;-25,00;-25,00;Despesas;CASH;Dinheiro;;2026-05-03 02:29:00;;;;0;false;;;4001;false'
    const report = await importWallet(db, newer)
    expect(report.imported).toBe(1)
    expect(report.skipped).toBe(3)
    expect(await db.transactions.count()).toBe(4)
  })

  it('routes unknown envelopes to Outros and reports them', async () => {
    const weird = HEADER + '\n' + 'Dinheiro;Misterioso;CNY;-9,00;-9,00;Despesas;CASH;Dinheiro;;2026-05-01 13:49:49;;;;0;false;;;9999;false'
    const report = await importWallet(db, weird)
    expect(report.imported).toBe(1)
    expect(report.unmappedEnvelopes).toEqual([{ envelopeId: 9999, category: 'Misterioso', count: 1 }])
    const cat = await db.categories.where('name').equals('Misterioso').first()
    expect((await db.groups.get(cat!.groupId))!.name).toBe('Outros')
  })

  it('flags in-file collisions for review rather than silently dropping', async () => {
    const dup = FIXTURE + '\n' + ROW_CAFE
    const report = await importWallet(db, dup)
    expect(report.imported).toBe(3)
    expect(report.collisions).toHaveLength(1)
    expect(report.collisions[0].row.category).toBe('Café')
    expect(await db.transactions.count()).toBe(3)

    // Explicitly accepting the collision imports it.
    const accepted = await importWallet(db, dup, { acceptCollisions: true })
    expect(accepted.imported).toBe(1)
    expect(await db.transactions.count()).toBe(4)
  })

  it('stores dates as local naive strings and money as integers', async () => {
    await importWallet(db, FIXTURE)
    const all = await db.transactions.toArray()
    for (const t of all) {
      expect(Number.isInteger(t.amountMinor)).toBe(true)
      expect(Number.isInteger(t.refAmountMinor)).toBe(true)
      expect(t.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
      expect(t.date.endsWith('Z')).toBe(false)
    }
  })
})
