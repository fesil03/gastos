import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo } from 'react'
import { db, setSetting } from '../db/db'
import { useAllTransactions, useTaxonomy, useUntrackedPeriods } from '../db/hooks'
import { DEFAULT_REF_CURRENCY } from '../db/types'
import { monthKey } from '../lib/dates'
import { useToday } from '../lib/useToday'
import { requestPush } from '../sync/autopush'
import { monthlyStats } from './engine'
import { BUDGET_SETTING, budgetGuidance, projectMonth, suggestBudget, type BudgetGuidance, type MonthlyBudget, type Projection } from './projection'

export interface MonthOutlook {
  month: string
  today: string
  currency: string
  projection: Projection
  /** The budget, when one is set in the current reference currency. */
  budget: MonthlyBudget | null
  /** A budget saved in another currency than the current reference one: shown, not applied. */
  otherCurrencyBudget: MonthlyBudget | null
  guidance: BudgetGuidance | null
  suggestionMinor: number | null
}

/** The current month's projection and budget guidance, shared by Insights and the entry screen. */
export function useMonthOutlook(): MonthOutlook | null {
  const txs = useAllTransactions()
  const { topUpIds, ready } = useTaxonomy()
  const untracked = useUntrackedPeriods()
  // Read the budget and the reference currency together, and tell "still loading" (undefined)
  // apart from "not set" (null) — otherwise the panel flashes "set a budget" on every open, and a
  // budget can briefly look like it's in the wrong currency before the real one has loaded.
  const settings = useLiveQuery(async () => {
    const [budget, ref] = await Promise.all([db.settings.get(BUDGET_SETTING), db.settings.get('refCurrency')])
    return { saved: (budget?.value as MonthlyBudget | undefined) ?? null, currency: (ref?.value as string | undefined) ?? DEFAULT_REF_CURRENCY }
  }, [])
  const today = useToday()
  const month = monthKey(today)

  return useMemo(() => {
    if (!txs || !ready || !untracked || !settings) return null
    const { saved, currency } = settings
    const stats = monthlyStats(txs, { untracked })
    const projection = projectMonth(txs, { month, asOf: today, untracked, topUpIds, stats })
    const valid = saved && Number.isSafeInteger(saved.amountMinor) && saved.amountMinor > 0 ? saved : null
    const budget = valid && valid.currency === currency ? valid : null
    return {
      month,
      today,
      currency,
      projection,
      budget,
      otherCurrencyBudget: valid && !budget ? valid : null,
      guidance: budget ? budgetGuidance(projection, budget.amountMinor) : null,
      suggestionMinor: suggestBudget(stats, month),
    }
  }, [txs, ready, untracked, topUpIds, settings, today, month])
}

/** Saves (or, with null, clears) the monthly budget; the change rides along with the next sync push. */
export async function saveBudget(amountMinor: number | null, currency: string): Promise<void> {
  if (amountMinor == null) await db.settings.delete(BUDGET_SETTING)
  else await setSetting(db, BUDGET_SETTING, { amountMinor, currency } satisfies MonthlyBudget)
  requestPush(db)
}
