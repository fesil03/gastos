import { describe, it, expect } from 'vitest'
import Dexie from 'dexie'
import { GastosDB } from './db'

// Schema v1 → v2 upgrade (spec v1): paymentMethod is dropped, isTopUp is derived, new tables appear.

describe('GastosDB v2 upgrade', () => {
  it('migrates a phase-6 (v1) database in place', async () => {
    const name = `gastos-upgrade-${Date.now()}`

    // Write a v1 database with the old shape.
    const v1 = new Dexie(name)
    v1.version(1).stores({
      transactions: '++id, date, categoryId, currency, *tags, [date+categoryId], externalHash',
      categories: '++id, groupId, name, archived',
      groups: '++id, name',
      tags: '++id, name',
      settings: 'key',
    })
    await v1.open()
    await v1.table('groups').add({ name: 'Alimentação', color: '#d95926', sortOrder: 0, kind: 'expense' })
    const cantinaId = await v1.table('categories').add({ groupId: 1, name: 'Cantina', archived: 0 })
    const cafeId = await v1.table('categories').add({ groupId: 1, name: 'Café', archived: 0 })
    await v1.table('transactions').add({
      amountMinor: -20000,
      currency: 'CNY',
      refAmountMinor: -20000,
      fxRate: 1,
      date: '2026-04-01T18:09:00',
      categoryId: cantinaId,
      tags: [],
      paymentMethod: 'wechat',
      source: 'manual',
      createdAt: '2026-04-01T18:09:05',
    })
    await v1.table('settings').put({ key: 'defaultPaymentMethod', value: 'wechat' })
    await v1.table('settings').put({ key: 'refCurrency', value: 'CNY' })
    v1.close()

    // Open with the current schema.
    const db = new GastosDB(name)
    await db.open()
    expect(db.verno).toBe(2)

    const tx = (await db.transactions.toArray())[0] as Record<string, unknown>
    expect('paymentMethod' in tx).toBe(false)
    expect(tx.amountMinor).toBe(-20000)

    const cats = await db.categories.toArray()
    expect(cats.find((c) => c.id === cantinaId)!.isTopUp).toBe(1)
    expect(cats.find((c) => c.id === cafeId)!.isTopUp).toBe(0)
    expect(await db.categories.where('isTopUp').equals(1).count()).toBe(1)

    expect(await db.settings.get('defaultPaymentMethod')).toBeUndefined()
    expect((await db.settings.get('refCurrency'))!.value).toBe('CNY')

    expect(await db.untrackedPeriods.count()).toBe(0)
    expect(await db.balanceChecks.count()).toBe(0)
    await db.untrackedPeriods.add({ start: '2025-01-01', end: '2025-04-30' })
    await db.balanceChecks.add({ date: '2026-06-01T10:00:00', account: 'Dinheiro', countedMinor: 120000 })
    expect(await db.untrackedPeriods.where('start').equals('2025-01-01').count()).toBe(1)
    expect(await db.balanceChecks.orderBy('date').count()).toBe(1)
    db.close()
  })
})
