import type { GastosDB } from '../db/db'
import { ensureTaxonomy } from '../db/taxonomy'
import { TOP_UP_CATEGORY_NAMES } from '../db/db'
import type { BalanceCheck, Category, Group, Setting, Tag, Transaction, UntrackedPeriod } from '../db/types'

// Full-fidelity JSON backup and restore.
// v1 (phase-6 build): groups, categories, tags, transactions (with paymentMethod), settings.
// v2 (spec v1): + untrackedPeriods, balanceChecks; categories carry isTopUp; no paymentMethod.

export const BACKUP_FORMAT = 'gastos-backup'
export const BACKUP_VERSION = 2

export interface Backup {
  format: typeof BACKUP_FORMAT
  version: number
  exportedAt: string
  groups: Group[]
  categories: Category[]
  tags: Tag[]
  transactions: Transaction[]
  untrackedPeriods: UntrackedPeriod[]
  balanceChecks: BalanceCheck[]
  settings: Setting[]
}

export async function buildBackup(db: GastosDB, exportedAt: string): Promise<Backup> {
  const [groups, categories, tags, transactions, untrackedPeriods, balanceChecks, settings] = await Promise.all([
    db.groups.toArray(),
    db.categories.toArray(),
    db.tags.toArray(),
    db.transactions.toArray(),
    db.untrackedPeriods.toArray(),
    db.balanceChecks.toArray(),
    db.settings.toArray(),
  ])
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt, groups, categories, tags, transactions, untrackedPeriods, balanceChecks, settings }
}

/** Parses v1 and v2 backups; v1 content is upgraded in memory to the v2 shape. */
export function parseBackup(text: string): Backup {
  const j = JSON.parse(text) as Partial<Backup>
  if (j.format !== BACKUP_FORMAT) throw new Error('Não é um backup do Gastos')
  if (typeof j.version !== 'number' || j.version > BACKUP_VERSION) throw new Error(`Versão de backup desconhecida (${j.version})`)
  for (const k of ['groups', 'categories', 'tags', 'transactions'] as const) {
    if (!Array.isArray(j[k])) throw new Error(`Backup sem "${k}"`)
  }
  const categories = j.categories!.map((c) => ({ ...c, isTopUp: (c.isTopUp ?? (TOP_UP_CATEGORY_NAMES.includes(c.name) ? 1 : 0)) as 0 | 1 }))
  const transactions = j.transactions!.map((t) => {
    const { paymentMethod: _dropped, ...rest } = t as Transaction & { paymentMethod?: unknown }
    return rest as Transaction
  })
  const settings = (j.settings ?? []).filter((s) => s.key !== 'defaultPaymentMethod')
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: j.exportedAt ?? '',
    groups: j.groups!,
    categories,
    tags: j.tags!,
    transactions,
    untrackedPeriods: Array.isArray(j.untrackedPeriods) ? j.untrackedPeriods : [],
    balanceChecks: Array.isArray(j.balanceChecks) ? j.balanceChecks : [],
    settings,
  }
}

export interface RestoreReport {
  mode: 'replace' | 'merge'
  transactions: number
  categories: number
  skipped: number
  untrackedPeriods: number
  balanceChecks: number
}

/**
 * replace: wipe everything and load the backup verbatim (ids preserved).
 * merge: keep current data; map the backup's taxonomy by name, add transactions that
 *        don't already exist (by externalHash when present, else by date+amount+currency+category).
 */
export async function restoreBackup(db: GastosDB, b: Backup, mode: 'replace' | 'merge'): Promise<RestoreReport> {
  if (mode === 'replace') {
    await db.transaction('rw', [db.groups, db.categories, db.tags, db.transactions, db.untrackedPeriods, db.balanceChecks, db.settings], async () => {
      await Promise.all([db.groups.clear(), db.categories.clear(), db.tags.clear(), db.transactions.clear(), db.untrackedPeriods.clear(), db.balanceChecks.clear(), db.settings.clear()])
      await db.groups.bulkAdd(b.groups)
      await db.categories.bulkAdd(b.categories)
      await db.tags.bulkAdd(b.tags)
      await db.transactions.bulkAdd(b.transactions)
      if (b.untrackedPeriods.length) await db.untrackedPeriods.bulkAdd(b.untrackedPeriods)
      if (b.balanceChecks.length) await db.balanceChecks.bulkAdd(b.balanceChecks)
      if (b.settings.length) await db.settings.bulkPut(b.settings)
    })
    await ensureTaxonomy(db)
    return { mode, transactions: b.transactions.length, categories: b.categories.length, skipped: 0, untrackedPeriods: b.untrackedPeriods.length, balanceChecks: b.balanceChecks.length }
  }

  await ensureTaxonomy(db)
  const groupIdByName = new Map((await db.groups.toArray()).map((g) => [g.name, g.id!]))
  const backupGroupName = new Map(b.groups.map((g) => [g.id!, g.name]))
  const outrosId = groupIdByName.get('Outros')!

  // categories by name
  const catIdMap = new Map<number, number>()
  let categoriesAdded = 0
  for (const c of b.categories) {
    const existing = await db.categories.where('name').equals(c.name).first()
    if (existing) catIdMap.set(c.id!, existing.id!)
    else {
      const groupId = groupIdByName.get(backupGroupName.get(c.groupId) ?? '') ?? outrosId
      const id = (await db.categories.add({ name: c.name, groupId, archived: c.archived ?? 0, isTopUp: c.isTopUp ?? 0, walletEnvelopeId: c.walletEnvelopeId, walletCustom: c.walletCustom })) as number
      catIdMap.set(c.id!, id)
      categoriesAdded++
    }
  }
  // tags by name
  const tagIdMap = new Map<number, number>()
  for (const t of b.tags) {
    const existing = await db.tags.where('name').equals(t.name).first()
    tagIdMap.set(t.id!, existing ? existing.id! : ((await db.tags.add({ name: t.name })) as number))
  }
  // transactions
  const existingHashes = new Set((await db.transactions.orderBy('externalHash').uniqueKeys()) as string[])
  const existingKeys = new Set<string>()
  const catNameOf = new Map((await db.categories.toArray()).map((c) => [c.id!, c.name]))
  await db.transactions.each((t) => existingKeys.add(`${t.date}|${t.amountMinor}|${t.currency}|${catNameOf.get(t.categoryId)}`))

  const toAdd: Transaction[] = []
  let skipped = 0
  const backupCatName = new Map(b.categories.map((c) => [c.id!, c.name]))
  for (const t of b.transactions) {
    const dup = t.externalHash ? existingHashes.has(t.externalHash) : existingKeys.has(`${t.date}|${t.amountMinor}|${t.currency}|${backupCatName.get(t.categoryId)}`)
    if (dup) {
      skipped++
      continue
    }
    const { id: _dropped, ...rest } = t
    toAdd.push({ ...rest, categoryId: catIdMap.get(t.categoryId) ?? t.categoryId, tags: t.tags.map((id) => tagIdMap.get(id) ?? id) })
  }
  if (toAdd.length) await db.transactions.bulkAdd(toAdd)

  // Untracked periods: add those not already present (same start+end). Balance checks: same date+account.
  let periodsAdded = 0
  const existingPeriods = new Set((await db.untrackedPeriods.toArray()).map((p) => `${p.start}|${p.end}`))
  for (const p of b.untrackedPeriods) {
    if (existingPeriods.has(`${p.start}|${p.end}`)) continue
    const { id: _pid, ...rest } = p
    await db.untrackedPeriods.add(rest)
    periodsAdded++
  }
  let checksAdded = 0
  const existingChecks = new Set((await db.balanceChecks.toArray()).map((c) => `${c.date}|${c.account}`))
  for (const c of b.balanceChecks) {
    if (existingChecks.has(`${c.date}|${c.account}`)) continue
    const { id: _cid, ...rest } = c
    await db.balanceChecks.add(rest)
    checksAdded++
  }
  return { mode, transactions: toAdd.length, categories: categoriesAdded, skipped, untrackedPeriods: periodsAdded, balanceChecks: checksAdded }
}
