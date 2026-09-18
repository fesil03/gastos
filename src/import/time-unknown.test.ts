import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { GastosDB } from '../db/db'
import { isTimeUnknown } from '../db/types'
import { importWallet } from './importer'
import { hourWeekdayHeatmap, smallTicketLeakage, ticketStats, categoryBreakdown } from '../insights/engine'
import { parseWalletCsv } from './wallet'

const HEADER =
  'account;category;currency;amount;ref_currency_amount;type;payment_type;payment_type_local;note;date;gps_latitude;gps_longitude;gps_accuracy_in_meters;warranty_in_month;transfer;payee;labels;envelope_id;custom_category'
const row = (cat: string, amt: string, date: string, env: number) =>
  `Dinheiro;${cat};CNY;-${amt};-${amt};Despesas;CASH;Dinheiro;;${date};;;;0;false;;;${env};false`

describe('isTimeUnknown', () => {
  it('claims only the midnight minute', () => {
    expect(isTimeUnknown('2026-08-01T00:00:00')).toBe(true)
    expect(isTimeUnknown('2026-08-01T00:00:31')).toBe(true)
    expect(isTimeUnknown('2026-08-01T00:00:59')).toBe(true)
    expect(isTimeUnknown('2026-08-01T00:01:00')).toBe(false)
    expect(isTimeUnknown('2026-08-01T00:02:49')).toBe(false) // earliest real time in the history
    expect(isTimeUnknown('2026-08-01T20:21:39')).toBe(false)
  })
})

describe('rows with no recorded clock time', () => {
  it('are flagged on import and kept out of the heatmap only', async () => {
    const csv = [
      HEADER,
      row('Táxi', '33,00', '2026-08-01 00:00:00', 4001),
      row('Café', '12,00', '2026-08-01 00:00:01', 1000),
      row('Táxi', '40,00', '2026-08-02 19:30:00', 4001), // a real timestamp
    ].join('\n')
    const db = new GastosDB(`tu-${Date.now()}`)
    const r = await importWallet(db, csv)
    expect(r.errors).toEqual([])
    expect(r.imported).toBe(3)

    const txs = await db.transactions.toArray()
    expect(txs.filter((t) => t.timeUnknown === 1)).toHaveLength(2)
    expect(txs.find((t) => t.date.startsWith('2026-08-02'))!.timeUnknown).toBeUndefined()

    // Heatmap: only the row with a real time survives, and it says what it dropped.
    const h = hourWeekdayHeatmap(txs)
    expect(h.count.flat().reduce((a, b) => a + b, 0)).toBe(1)
    expect(h.excludedUnknownTime).toBe(2)
    expect(h.count[6][19]).toBe(1) // Sunday 2 Aug 2026, 19h

    // Everything else still counts all three.
    expect(categoryBreakdown(txs).reduce((s, c) => s + c.count, 0)).toBe(3)
    expect(categoryBreakdown(txs).reduce((s, c) => s + c.totalMinor, 0)).toBe(8500)
    expect(ticketStats(txs).count).toBe(3)
    expect(smallTicketLeakage(txs)[0].count).toBe(3)
  })

  it('maps Wallet envelope 6002 (Esporte ativo, fitness) to Vida & Lazer, not Outros', async () => {
    const csv = [HEADER, row('Esporte ativo, fitness', '90,00', '2026-08-02 00:00:00', 6002)].join('\n')
    const db = new GastosDB(`env-${Date.now()}`)
    const r = await importWallet(db, csv)
    expect(r.unmappedEnvelopes).toEqual([])
    const cat = (await db.categories.toArray()).find((c) => c.name === 'Esporte ativo, fitness')!
    const group = (await db.groups.get(cat.groupId))!
    expect(group.name).toBe('Vida & Lazer')
  })

  it('leaves the real export untouched — no historical row lands in the midnight minute', () => {
    const f = resolve(__dirname, '../../fixtures/gastos_report_2026-05-02_203027.csv')
    if (!existsSync(f)) return
    const { rows } = parseWalletCsv(readFileSync(f, 'utf-8'))
    expect(rows.filter((r) => r.timeUnknown)).toHaveLength(0)
  })
})

describe('rows imported before the flag existed', () => {
  it('are still kept out of the heatmap, derived from the timestamp alone', async () => {
    const db = new GastosDB(`legacy-${Date.now()}`)
    const csv = [HEADER, row('Táxi', '40,00', '2026-08-02 19:30:00', 4001)].join('\n')
    await importWallet(db, csv)
    const cat = (await db.categories.toArray())[0]
    // written the way an older build would have: midnight timestamp, no timeUnknown field
    await db.transactions.add({
      amountMinor: -3300, currency: 'CNY', refAmountMinor: -3300, fxRate: 1,
      date: '2026-08-01T00:00:00', categoryId: cat.id!, tags: [], source: 'wallet-import',
      createdAt: '2026-08-01T00:00:00',
    })
    const txs = await db.transactions.toArray()
    expect(txs.find((t) => t.date.startsWith('2026-08-01'))!.timeUnknown).toBeUndefined()
    const h = hourWeekdayHeatmap(txs)
    expect(h.excludedUnknownTime).toBe(1)
    expect(h.count.flat().reduce((a, b) => a + b, 0)).toBe(1)
  })
})
