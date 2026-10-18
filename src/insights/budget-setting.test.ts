import { describe, it, expect } from 'vitest'
import { GastosDB, getSetting, setSetting } from '../db/db'
import { ensureTaxonomy } from '../db/taxonomy'
import { buildBackup, parseBackup, restoreBackup } from '../export/backup'
import { BUDGET_SETTING, type MonthlyBudget } from './projection'

// The budget lives in the settings table, which the sync snapshot and the JSON backup carry.
// A pull is a 'replace' restore of that snapshot, so this round trip is what the laptop sees.
describe('monthly budget setting', () => {
  it('survives the snapshot / backup round trip that sync and restore use', async () => {
    const phone = new GastosDB(`budget-src-${Date.now()}`)
    await ensureTaxonomy(phone)
    await setSetting(phone, BUDGET_SETTING, { amountMinor: 500_000, currency: 'CNY' } satisfies MonthlyBudget)

    const snapshot = JSON.stringify(await buildBackup(phone, '2026-10-18T19:00:00'))
    const laptop = new GastosDB(`budget-dst-${Date.now()}`)
    await restoreBackup(laptop, parseBackup(snapshot), 'replace')

    expect(await getSetting<MonthlyBudget | null>(laptop, BUDGET_SETTING, null)).toEqual({ amountMinor: 500_000, currency: 'CNY' })
  })

  it('a backup from before budgets existed restores with no budget set', async () => {
    const old = new GastosDB(`budget-old-${Date.now()}`)
    await ensureTaxonomy(old)
    const snapshot = JSON.stringify(await buildBackup(old, '2026-09-18T11:45:00'))
    const target = new GastosDB(`budget-new-${Date.now()}`)
    await restoreBackup(target, parseBackup(snapshot), 'replace')
    expect(await getSetting<MonthlyBudget | null>(target, BUDGET_SETTING, null)).toBeNull()
  })
})
