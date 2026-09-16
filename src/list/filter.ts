import type { Category, Transaction } from '../db/types'

export interface TxFilter {
  query?: string // matches note, item, category name (case/accents-insensitive)
  categoryIds?: number[]
  groupIds?: number[]
  tagIds?: number[] // transaction must carry ALL of these
  fromDay?: string // 'YYYY-MM-DD' inclusive
  toDay?: string // inclusive
  currency?: string
  onlyIncome?: boolean
  onlyExpense?: boolean
}

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

export function filterTransactions(txs: Transaction[], f: TxFilter, categoryById: Map<number, Category>): Transaction[] {
  const q = f.query ? normalize(f.query.trim()) : ''
  const cats = f.categoryIds?.length ? new Set(f.categoryIds) : null
  const groups = f.groupIds?.length ? new Set(f.groupIds) : null
  const tags = f.tagIds?.length ? f.tagIds : null
  const from = f.fromDay ? `${f.fromDay}T00:00:00` : null
  const to = f.toDay ? `${f.toDay}T23:59:59` : null

  const catNameCache = new Map<number, string>()
  const catName = (id: number) => {
    let n = catNameCache.get(id)
    if (n === undefined) {
      n = normalize(categoryById.get(id)?.name ?? '')
      catNameCache.set(id, n)
    }
    return n
  }

  return txs.filter((t) => {
    if (from && t.date < from) return false
    if (to && t.date > to) return false
    if (cats && !cats.has(t.categoryId)) return false
    if (groups) {
      const c = categoryById.get(t.categoryId)
      if (!c || !groups.has(c.groupId)) return false
    }
    if (tags && !tags.every((id) => t.tags.includes(id))) return false
    if (f.currency && t.currency !== f.currency) return false
    if (f.onlyIncome && t.amountMinor <= 0) return false
    if (f.onlyExpense && t.amountMinor >= 0) return false
    if (q) {
      const hay = `${normalize(t.note ?? '')} ${normalize(t.item ?? '')} ${catName(t.categoryId)}`
      if (!hay.includes(q)) return false
      // Allow searching an amount like "18,8" or "18.8"
    }
    return true
  })
}

/** Group by day (desc), newest first inside each day. */
export function groupByDay(txs: Transaction[]): { day: string; txs: Transaction[]; totalRefMinor: number }[] {
  const sorted = txs.slice().sort((a, b) => b.date.localeCompare(a.date) || (b.id ?? 0) - (a.id ?? 0))
  const out: { day: string; txs: Transaction[]; totalRefMinor: number }[] = []
  for (const t of sorted) {
    const day = t.date.slice(0, 10)
    const last = out[out.length - 1]
    if (last && last.day === day) {
      last.txs.push(t)
      last.totalRefMinor += t.refAmountMinor
    } else {
      out.push({ day, txs: [t], totalRefMinor: t.refAmountMinor })
    }
  }
  return out
}

export function isEmptyFilter(f: TxFilter): boolean {
  return !f.query && !f.categoryIds?.length && !f.groupIds?.length && !f.tagIds?.length && !f.fromDay && !f.toDay && !f.currency && !f.onlyIncome && !f.onlyExpense
}
