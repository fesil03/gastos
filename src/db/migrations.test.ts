import { describe, it, expect } from 'vitest'
import { GastosDB, getSetting } from './db'
import { ensureCategory, ensureTaxonomy } from './taxonomy'
import { migrateTaxonomy, nameKey, TAXONOMY_LOG_KEY, TAXONOMY_MIGRATIONS, TAXONOMY_VERSION_KEY, type MergeLogEntry, type TaxonomyMigration } from './migrations'
import { rankCategories } from '../entry/ranking'
import type { Transaction } from './types'
import { importWallet } from '../import/importer'
import { buildBackup, parseBackup, restoreBackup } from '../export/backup'

let n = 0
const freshDb = () => new GastosDB(`gastos-mig-${Date.now()}-${n++}`)

const HEADER =
  'account;category;currency;amount;ref_currency_amount;type;payment_type;payment_type_local;note;date;gps_latitude;gps_longitude;gps_accuracy_in_meters;warranty_in_month;transfer;payee;labels;envelope_id;custom_category'
const csvRow = (category: string, amount: string, date: string, env: number) => `Dinheiro;${category};CNY;${amount};${amount};Despesas;CASH;Dinheiro;;${date};;;;0;false;;;${env};false`

function tx(categoryId: number, minor: number, date: string, extra: Partial<Transaction> = {}): Transaction {
  return { amountMinor: -minor, currency: 'CNY', refAmountMinor: -minor, fxRate: 1, date, categoryId, tags: [], source: 'manual', createdAt: date, ...extra }
}

const RENAME: TaxonomyMigration[] = [
  { version: 1, renames: [{ from: ['Saúde e beleza'], to: 'Higiene & skincare' }] },
]

describe('nameKey', () => {
  it('ignores case, accents, punctuation and spacing', () => {
    expect(nameKey('Farmácia, drogaria')).toBe(nameKey('farmacia  drogaria'))
    expect(nameKey('Saúde e beleza')).toBe(nameKey('SAUDE E BELEZA'))
    expect(nameKey('Saúde e beleza')).not.toBe(nameKey('Bem-estar, beleza'))
  })
})

describe('migrateTaxonomy — additions', () => {
  it('adds Bike under Transporte once, then records the version', async () => {
    const db = freshDb()
    const groups = await ensureTaxonomy(db)
    const r = await migrateTaxonomy(db)
    expect(r.added).toEqual(['Bike'])
    const bike = await db.categories.where('name').equals('Bike').first()
    expect(bike?.groupId).toBe(groups.get('Transporte'))
    expect(await getSetting(db, TAXONOMY_VERSION_KEY, 0)).toBe(TAXONOMY_MIGRATIONS[TAXONOMY_MIGRATIONS.length - 1].version)

    const again = await migrateTaxonomy(db)
    expect(again.added).toEqual([])
    expect(await db.categories.where('name').equals('Bike').count()).toBe(1)
  })

  it('does not add Bike when an equivalent category already exists', async () => {
    const db = freshDb()
    const groups = await ensureTaxonomy(db)
    await ensureCategory(db, 'Bicicleta', groups.get('Transporte')!)
    const r = await migrateTaxonomy(db)
    expect(r.added).toEqual([])
    expect(await db.categories.where('name').equals('Bike').count()).toBe(0)
  })

  it('a restored backup from before the version re-runs it harmlessly', async () => {
    const db = freshDb()
    await ensureTaxonomy(db)
    await migrateTaxonomy(db)
    await db.settings.delete(TAXONOMY_VERSION_KEY) // as if an old backup replaced the settings
    const r = await migrateTaxonomy(db)
    expect(r.added).toEqual([])
    expect(await db.categories.where('name').equals('Bike').count()).toBe(1)
  })
})

describe('migrateTaxonomy — renames', () => {
  async function seeded() {
    const db = freshDb()
    const groups = await ensureTaxonomy(db)
    const hb = await ensureCategory(db, 'Saúde e beleza', groups.get('Saúde')!, { walletEnvelopeId: 2002 })
    await db.transactions.bulkAdd([tx(hb, 8900, '2026-10-01T10:00:00'), tx(hb, 4500, '2026-10-12T21:00:00')])
    return { db, groups, hb }
  }

  it('renames in place: same id, every transaction untouched, old name kept as an alias', async () => {
    const { db, hb } = await seeded()
    const before = await db.transactions.toArray()
    const r = await migrateTaxonomy(db, RENAME)
    expect(r.renamed).toEqual([{ from: 'Saúde e beleza', to: 'Higiene & skincare' }])
    const cat = await db.categories.get(hb)
    expect(cat?.name).toBe('Higiene & skincare')
    expect(cat?.aliases).toEqual(['Saúde e beleza'])
    expect(cat?.walletEnvelopeId).toBe(2002)
    expect(await db.transactions.toArray()).toEqual(before)
  })

  it('matches the old name loosely (case, accents, punctuation)', async () => {
    const db = freshDb()
    const groups = await ensureTaxonomy(db)
    const id = await ensureCategory(db, 'saude  e Beleza', groups.get('Saúde')!)
    await migrateTaxonomy(db, RENAME)
    expect((await db.categories.get(id))?.name).toBe('Higiene & skincare')
  })

  it('never merges: if the new name already exists, both stay as they are', async () => {
    const { db, groups, hb } = await seeded()
    const other = await ensureCategory(db, 'Higiene & skincare', groups.get('Saúde')!)
    const r = await migrateTaxonomy(db, RENAME)
    expect(r.renamed).toEqual([])
    expect(r.skipped).toHaveLength(1)
    expect((await db.categories.get(hb))?.name).toBe('Saúde e beleza')
    expect((await db.categories.get(other))?.name).toBe('Higiene & skincare')
    expect(await db.transactions.where('categoryId').equals(hb).count()).toBe(2)
  })

  it('can move the category to another group as part of the rename', async () => {
    const { db, groups, hb } = await seeded()
    await migrateTaxonomy(db, [{ version: 1, renames: [{ from: ['Saúde e beleza'], to: 'Higiene & skincare', group: 'Compras' }] }])
    expect((await db.categories.get(hb))?.groupId).toBe(groups.get('Compras'))
  })

  it('a missing source is reported, not an error', async () => {
    const db = freshDb()
    await ensureTaxonomy(db)
    const r = await migrateTaxonomy(db, RENAME)
    expect(r.renamed).toEqual([])
    expect(r.skipped[0].step).toContain('Higiene & skincare')
    expect(await getSetting(db, TAXONOMY_VERSION_KEY, 0)).toBe(1)
  })

  it('a Wallet CSV still carrying the old name imports onto the renamed category', async () => {
    const { db, hb } = await seeded()
    await migrateTaxonomy(db, RENAME)
    const before = await db.categories.count()
    const r = await importWallet(db, [HEADER, csvRow('Saúde e beleza', '-59,00', '2026-10-20 12:00:00', 2002)].join('\n'))
    expect(r.imported).toBe(1)
    expect(await db.categories.count()).toBe(before)
    expect(await db.transactions.where('categoryId').equals(hb).count()).toBe(3)
  })

  it('merging a backup taken before the rename adds no old-named category and no duplicates', async () => {
    const { db, hb } = await seeded()
    const oldBackup = JSON.stringify(await buildBackup(db, '2026-10-20T08:00:00'))
    await migrateTaxonomy(db, RENAME)
    const report = await restoreBackup(db, parseBackup(oldBackup), 'merge')
    expect(report.categories).toBe(0)
    expect(report.transactions).toBe(0)
    expect(report.skipped).toBe(2)
    expect(await db.categories.filter((c) => c.name === 'Saúde e beleza').count()).toBe(0)
    expect(await db.transactions.where('categoryId').equals(hb).count()).toBe(2)
  })
})

describe('migrateTaxonomy — merges and archive', () => {
  const GIFTS: TaxonomyMigration[] = [
    {
      version: 1,
      renames: [{ from: ['Caridade, presentes'], to: 'Presentes & doações', group: 'Vida & Lazer' }],
      merges: [{ from: ['Presentes, alegrias'], into: 'Presentes & doações' }],
      archive: ['Lojinhas'],
    },
  ]
  async function seeded() {
    const db = freshDb()
    const groups = await ensureTaxonomy(db)
    const charity = await ensureCategory(db, 'Caridade, presentes', groups.get('Vida & Lazer')!)
    const gifts = await ensureCategory(db, 'Presentes, alegrias', groups.get('Compras')!)
    const shop = await ensureCategory(db, 'Lojinhas', groups.get('Alimentação')!)
    await db.transactions.bulkAdd([
      tx(charity, 10000, '2025-01-05T10:00:00'),
      tx(gifts, 14100, '2026-05-02T20:21:39'),
      tx(gifts, 5000, '2026-09-17T18:00:00', { note: 'aniversário' }),
      tx(shop, 800, '2024-03-01T09:00:00'),
    ])
    return { db, groups, charity, gifts, shop }
  }

  it('moves the entries, keeps everything else on each row, logs the ids, removes the empty category', async () => {
    const { db, charity, gifts } = await seeded()
    const before = await db.transactions.where('categoryId').equals(gifts).toArray()
    const r = await migrateTaxonomy(db, GIFTS)
    expect(r.merged).toEqual([{ from: 'Presentes, alegrias', into: 'Presentes & doações', moved: 2 }])
    expect(await db.categories.get(gifts)).toBeUndefined()
    const moved = await db.transactions.bulkGet(before.map((t) => t.id!))
    expect(moved.map((t) => t!.categoryId)).toEqual([charity, charity])
    expect(moved.map((t) => ({ ...t, categoryId: 0 }))).toEqual(before.map((t) => ({ ...t, categoryId: 0 })))
    expect(await db.transactions.count()).toBe(4)
    const log = await getSetting<MergeLogEntry[]>(db, TAXONOMY_LOG_KEY, [])
    expect(log).toHaveLength(1)
    expect(log[0].from.name).toBe('Presentes, alegrias')
    expect(log[0].movedTransactionIds.sort()).toEqual(before.map((t) => t.id!).sort())
    expect((await db.categories.get(charity))?.aliases).toEqual(['Caridade, presentes', 'Presentes, alegrias'])
  })

  it('archives without touching history, and running again changes nothing', async () => {
    const { db, shop } = await seeded()
    const r = await migrateTaxonomy(db, GIFTS)
    expect(r.archived).toEqual(['Lojinhas'])
    expect((await db.categories.get(shop))?.archived).toBe(1)
    expect(await db.transactions.where('categoryId').equals(shop).count()).toBe(1)
    const snapshot = JSON.stringify([await db.categories.toArray(), await db.transactions.toArray()])
    await db.settings.delete(TAXONOMY_VERSION_KEY)
    const again = await migrateTaxonomy(db, GIFTS)
    expect([again.renamed, again.merged, again.archived]).toEqual([[], [], []])
    expect(JSON.stringify([await db.categories.toArray(), await db.transactions.toArray()])).toBe(snapshot)
  })

  it('a CSV row with the merged-away name lands on the survivor', async () => {
    const { db, charity } = await seeded()
    await migrateTaxonomy(db, GIFTS)
    await importWallet(db, [HEADER, csvRow('Presentes, alegrias', '-30,00', '2026-10-21 12:00:00', 2007)].join('\n'))
    expect(await db.categories.filter((c) => c.name === 'Presentes, alegrias').count()).toBe(0)
    expect(await db.transactions.where('categoryId').equals(charity).count()).toBe(4)
  })

  it('archived categories never come back as entry chips, even from all-time history', async () => {
    const { db, shop } = await seeded()
    await migrateTaxonomy(db, GIFTS)
    const txs = await db.transactions.toArray()
    const archived = new Set((await db.categories.toArray()).filter((c) => c.archived === 1).map((c) => c.id!))
    expect(rankCategories(txs, { now: new Date(2026, 9, 25) }).some((r) => r.categoryId === shop)).toBe(true)
    expect(rankCategories(txs, { now: new Date(2026, 9, 25), exclude: archived }).some((r) => r.categoryId === shop)).toBe(false)
  })
})

describe('the shipped migration (v1)', () => {
  it('on a database shaped like the real one: renames Saúde, merges gifts, archives, adds Bike', async () => {
    const db = freshDb()
    const g = await ensureTaxonomy(db)
    const mk = (name: string, group: string) => ensureCategory(db, name, g.get(group as never)!)
    const ids = {
      hb: await mk('Saúde e beleza', 'Saúde'),
      wb: await mk('Bem-estar, beleza', 'Saúde'),
      ph: await mk('Farmácia, drogaria', 'Saúde'),
      md: await mk('Cuidados de saúde, médico', 'Saúde'),
      gifts: await mk('Presentes, alegrias', 'Compras'),
      charity: await mk('Caridade, presentes', 'Vida & Lazer'),
      fora: await mk('Fora de Casa', 'Alimentação'),
      loj: await mk('Lojinhas', 'Alimentação'),
      taxi: await mk('Táxi', 'Transporte'),
    }
    await db.transactions.bulkAdd(Object.values(ids).map((id, i) => tx(id, 1000 + i, `2026-0${(i % 9) + 1}-10T12:00:00`)))
    const before = await db.transactions.count()
    const r = await migrateTaxonomy(db)
    const name = async (id: number) => (await db.categories.get(id))?.name
    expect(await name(ids.hb)).toBe('Higiene & skincare')
    expect(await name(ids.wb)).toBe('Massagem & salão')
    expect(await name(ids.md)).toBe('Médico & exames')
    expect(await name(ids.ph)).toBe('Farmácia')
    expect(await name(ids.charity)).toBe('Presentes & doações')
    expect((await db.categories.get(ids.charity))?.groupId).toBe(g.get('Vida & Lazer'))
    expect(await db.categories.get(ids.gifts)).toBeUndefined()
    expect((await db.categories.get(ids.fora))?.archived).toBe(1)
    expect((await db.categories.get(ids.loj))?.archived).toBe(1)
    expect(await name(ids.taxi)).toBe('Táxi')
    expect(r.added).toEqual(['Bike'])
    expect(r.skipped).toEqual([])
    expect(await db.transactions.count()).toBe(before)
  })
})

describe('migrateTaxonomy — moves of exact entries', () => {
  const MOVES: TaxonomyMigration[] = [
    {
      version: 1,
      moves: [
        { date: '2026-01-19T18:11:44', amountMinor: -7900, from: 'Farmácia', to: 'Higiene & skincare' },
        { date: '2026-10-14T16:04:24', amountMinor: -7090, from: 'Farmácia', to: 'Higiene & skincare' },
      ],
    },
  ]
  async function seeded() {
    const db = freshDb()
    const g = await ensureTaxonomy(db)
    const ph = await ensureCategory(db, 'Farmácia', g.get('Saúde')!)
    const sk = await ensureCategory(db, 'Higiene & skincare', g.get('Saúde')!)
    const [a, b, keep, later] = (await db.transactions.bulkAdd(
      [
        tx(ph, 7900, '2026-01-19T18:11:44'),
        tx(ph, 7090, '2026-10-14T16:04:24'),
        tx(ph, 7900, '2026-01-19T18:11:45'), // one second off: not the listed entry
        tx(ph, 3500, '2026-11-03T10:00:00'), // a real medicine logged later
      ],
      { allKeys: true },
    )) as number[]
    return { db, ph, sk, a, b, keep, later }
  }

  it('moves exactly the listed entries and logs their ids', async () => {
    const { db, ph, sk, a, b, keep, later } = await seeded()
    const r = await migrateTaxonomy(db, MOVES)
    expect(r.moved).toEqual([{ from: 'Farmácia', to: 'Higiene & skincare', count: 2 }])
    expect((await db.transactions.get(a))?.categoryId).toBe(sk)
    expect((await db.transactions.get(b))?.categoryId).toBe(sk)
    expect((await db.transactions.get(keep))?.categoryId).toBe(ph)
    expect((await db.transactions.get(later))?.categoryId).toBe(ph)
    const log = await getSetting<MergeLogEntry[]>(db, TAXONOMY_LOG_KEY, [])
    expect(log.map((e) => [e.kind, e.movedTransactionIds.sort()])).toEqual([['moves', [a, b].sort()]])
  })

  it('re-running (e.g. after an old backup reset the version) changes nothing', async () => {
    const { db } = await seeded()
    await migrateTaxonomy(db, MOVES)
    const snapshot = JSON.stringify(await db.transactions.toArray())
    await db.settings.delete(TAXONOMY_VERSION_KEY)
    const again = await migrateTaxonomy(db, MOVES)
    expect(again.moved).toEqual([])
    expect(JSON.stringify(await db.transactions.toArray())).toBe(snapshot)
    expect(await getSetting<MergeLogEntry[]>(db, TAXONOMY_LOG_KEY, [])).toHaveLength(1)
  })

  it('an ambiguous pick (two identical entries) is skipped, not guessed', async () => {
    const { db, ph } = await seeded()
    await db.transactions.add(tx(ph, 7900, '2026-01-19T18:11:44'))
    const r = await migrateTaxonomy(db, MOVES)
    expect(r.moved).toEqual([{ from: 'Farmácia', to: 'Higiene & skincare', count: 1 }])
    expect(r.skipped.map((s) => s.reason)).toEqual(['mais de um lançamento igual; não movo'])
    expect(await db.transactions.where('categoryId').equals(ph).count()).toBe(4)
  })
})
