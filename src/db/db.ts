import Dexie, { type EntityTable } from 'dexie'
import type { BalanceCheck, Category, Group, Setting, Tag, Transaction, UntrackedPeriod } from './types'

/** Categories that are prepaid top-ups, not purchases (spec §3). Matched by name at seed / upgrade time. */
export const TOP_UP_CATEGORY_NAMES = ['Cantina']

// db.ts — spec §5. Schema strings list *indexes* only; other fields are free-form.
export class GastosDB extends Dexie {
  transactions!: EntityTable<Transaction, 'id'>
  categories!: EntityTable<Category, 'id'>
  groups!: EntityTable<Group, 'id'>
  tags!: EntityTable<Tag, 'id'>
  untrackedPeriods!: EntityTable<UntrackedPeriod, 'id'>
  balanceChecks!: EntityTable<BalanceCheck, 'id'>
  settings!: EntityTable<Setting, 'key'>

  constructor(name = 'gastos') {
    super(name)
    // v1 — phase-6 build against spec v0 (had a paymentMethod field, no top-ups / coverage tables).
    this.version(1).stores({
      transactions: '++id, date, categoryId, currency, *tags, [date+categoryId], externalHash',
      categories: '++id, groupId, name, archived',
      groups: '++id, name',
      tags: '++id, name',
      settings: 'key',
    })
    // v2 — spec v1: drop paymentMethod, add isTopUp, untrackedPeriods, balanceChecks.
    this.version(2)
      .stores({
        transactions: '++id, date, categoryId, currency, *tags, [date+categoryId], externalHash',
        categories: '++id, groupId, name, archived, isTopUp',
        groups: '++id, name',
        tags: '++id, name',
        untrackedPeriods: '++id, start, end',
        balanceChecks: '++id, date',
        settings: 'key',
      })
      .upgrade(async (tx) => {
        await tx
          .table('transactions')
          .toCollection()
          .modify((t: Record<string, unknown>) => {
            delete t.paymentMethod
          })
        await tx
          .table('categories')
          .toCollection()
          .modify((c: Category) => {
            c.isTopUp = TOP_UP_CATEGORY_NAMES.includes(c.name) ? 1 : 0
          })
        await tx.table('settings').delete('defaultPaymentMethod')
      })
  }
}

export const db = new GastosDB()

export async function getSetting<T>(d: GastosDB, key: string, fallback: T): Promise<T> {
  const row = await d.settings.get(key)
  return row ? (row.value as T) : fallback
}

export async function setSetting(d: GastosDB, key: string, value: unknown): Promise<void> {
  await d.settings.put({ key, value })
}
