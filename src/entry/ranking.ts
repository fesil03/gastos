import type { Transaction } from '../db/types'
import { dayKey, fromLocalIso } from '../lib/dates'

// Category chips ordered by *your* frequency in a rolling 90-day window (spec §7).
// If the window is thin (a tracking gap, a fresh install), backfill from all-time
// frequency so the pad never shows fewer than `limit` chips when data exists.

export interface RankedCategory {
  categoryId: number
  recentCount: number
  allTimeCount: number
  lastAmountMinor?: number // most recent amount, for long-press quick-repeat
  lastCurrency?: string
}

export function rankCategories(
  txs: Iterable<Transaction>,
  opts: { now?: Date; windowDays?: number; limit?: number } = {},
): RankedCategory[] {
  const { now = new Date(), windowDays = 90, limit = 8 } = opts
  const cutoff = dayKey(now, -windowDays)
  const byCat = new Map<number, RankedCategory & { lastDate: string }>()

  for (const t of txs) {
    if (t.amountMinor >= 0) continue // income never earns a chip
    let r = byCat.get(t.categoryId)
    if (!r) {
      r = { categoryId: t.categoryId, recentCount: 0, allTimeCount: 0, lastDate: '' }
      byCat.set(t.categoryId, r)
    }
    r.allTimeCount++
    if (t.date >= cutoff) r.recentCount++
    if (t.date > r.lastDate) {
      r.lastDate = t.date
      r.lastAmountMinor = t.amountMinor
      r.lastCurrency = t.currency
    }
  }

  const ranked = [...byCat.values()].sort(
    (a, b) => b.recentCount - a.recentCount || b.allTimeCount - a.allTimeCount || b.lastDate.localeCompare(a.lastDate),
  )
  return ranked.slice(0, limit).map(({ lastDate: _ignored, ...rest }) => rest)
}

/** Share of all expense transactions covered by the given category ids (for tests / sanity). */
export function coverage(txs: Transaction[], ids: number[]): number {
  const set = new Set(ids)
  const expenses = txs.filter((t) => t.amountMinor < 0)
  if (!expenses.length) return 0
  return expenses.filter((t) => set.has(t.categoryId)).length / expenses.length
}

export function isWithinDays(iso: string, days: number, now = new Date()): boolean {
  return fromLocalIso(iso).getTime() >= now.getTime() - days * 86_400_000
}
