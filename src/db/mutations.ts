import { db, getSetting } from './db'
import { ensureTaxonomy } from './taxonomy'
import { DEFAULT_REF_CURRENCY, type BalanceCheck, type Transaction, type UntrackedPeriod } from './types'
import { convertMinor } from '../lib/money'
import { monthBounds, nowIso } from '../lib/dates'

export interface NewTransactionInput {
  amountMinor: number // signed
  currency?: string
  fxRate?: number // 1 currency → refCurrency; required when currency !== refCurrency
  date?: string // local naive ISO; defaults to now
  categoryId: number
  tags?: number[]
  note?: string
  item?: string
  qty?: number
  unitPrice?: number
}

/** Adds a manual transaction and returns its id. Computes refAmountMinor from the stored rate. */
export async function addTransaction(input: NewTransactionInput): Promise<number> {
  const refCurrency = await getSetting(db, 'refCurrency', DEFAULT_REF_CURRENCY)
  const currency = input.currency ?? refCurrency
  const fxRate = currency === refCurrency ? 1 : (input.fxRate ?? (await lastFxRate(currency)) ?? 1)
  const createdAt = nowIso()
  const tx: Transaction = {
    amountMinor: input.amountMinor,
    currency,
    refAmountMinor: convertMinor(input.amountMinor, fxRate),
    fxRate,
    date: input.date ?? createdAt,
    categoryId: input.categoryId,
    tags: input.tags ?? [],
    source: 'manual',
    createdAt,
  }
  if (input.note) tx.note = input.note
  if (input.item) tx.item = input.item
  if (input.qty != null) tx.qty = input.qty
  if (input.unitPrice != null) tx.unitPrice = input.unitPrice
  if (currency !== refCurrency) await db.settings.put({ key: `fxRate:${currency}`, value: fxRate })
  return (await db.transactions.add(tx)) as number
}

export async function updateTransaction(id: number, patch: Partial<Transaction>): Promise<void> {
  const existing = await db.transactions.get(id)
  if (!existing) return
  const refCurrency = await getSetting(db, 'refCurrency', DEFAULT_REF_CURRENCY)
  const next: Transaction = { ...existing, ...patch }
  if (next.currency === refCurrency) next.fxRate = 1
  next.refAmountMinor = convertMinor(next.amountMinor, next.fxRate)
  // Drop empty optionals so they don't linger as '' / undefined keys.
  for (const k of ['note', 'item', 'qty', 'unitPrice'] as const) {
    if (next[k] === '' || next[k] === undefined || next[k] === null) delete next[k]
  }
  await db.transactions.put(next)
}

export async function deleteTransaction(id: number): Promise<Transaction | undefined> {
  const existing = await db.transactions.get(id)
  if (existing) await db.transactions.delete(id)
  return existing
}

/** Restores a deleted transaction (undo). Keeps the original id. */
export async function restoreTransaction(tx: Transaction): Promise<void> {
  await db.transactions.put(tx)
}

export async function lastFxRate(currency: string): Promise<number | undefined> {
  const s = await db.settings.get(`fxRate:${currency}`)
  if (s) return s.value as number
  const last = await db.transactions.where('currency').equals(currency).reverse().sortBy('date')
  return last[0]?.fxRate
}

export async function ensureTag(name: string): Promise<number> {
  const clean = name.trim().replace(/^#/, '')
  const existing = await db.tags.where('name').equals(clean).first()
  if (existing) return existing.id!
  return (await db.tags.add({ name: clean })) as number
}

export async function addCategory(name: string, groupId: number, isTopUp = false): Promise<number> {
  return (await db.categories.add({ name: name.trim(), groupId, archived: 0, isTopUp: isTopUp ? 1 : 0 })) as number
}

export async function setCategoryTopUp(id: number, isTopUp: boolean): Promise<void> {
  await db.categories.update(id, { isTopUp: isTopUp ? 1 : 0 })
}

export async function seedIfEmpty(): Promise<void> {
  await ensureTaxonomy(db)
}

// ---------- Untracked periods (spec §8) ----------

/**
 * Declare [start, end] (inclusive days) as deliberately untracked. Overlapping or adjacent
 * periods are merged so the table stays a clean list of disjoint ranges.
 */
export async function declareUntracked(start: string, end: string, reason?: string): Promise<number> {
  if (end < start) [start, end] = [end, start]
  return db.transaction('rw', db.untrackedPeriods, async () => {
    const all = await db.untrackedPeriods.toArray()
    const touching = all.filter((p) => p.start <= nextDay(end) && p.end >= prevDay(start))
    let s = start
    let e = end
    const reasons = new Set<string>(reason ? [reason] : [])
    for (const p of touching) {
      if (p.start < s) s = p.start
      if (p.end > e) e = p.end
      if (p.reason) reasons.add(p.reason)
      await db.untrackedPeriods.delete(p.id!)
    }
    const merged: UntrackedPeriod = { start: s, end: e }
    if (reasons.size) merged.reason = [...reasons].join(' · ')
    return (await db.untrackedPeriods.add(merged)) as number
  })
}

/** One-tap "I wasn't tracking then" for a whole month. */
export async function declareMonthUntracked(month: string, reason = 'não estava registrando'): Promise<number> {
  const [s, e] = monthBounds(month)
  return declareUntracked(s, e, reason)
}

export async function removeUntracked(id: number): Promise<void> {
  await db.untrackedPeriods.delete(id)
}

function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const x = new Date(y, m - 1, d + 1)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}
function prevDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const x = new Date(y, m - 1, d - 1)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

// ---------- Balance checks (spec §8.1) ----------

export async function addBalanceCheck(input: Omit<BalanceCheck, 'id'>): Promise<number> {
  const row: BalanceCheck = { date: input.date, account: input.account, countedMinor: input.countedMinor }
  if (input.note?.trim()) row.note = input.note.trim()
  return (await db.balanceChecks.add(row)) as number
}

export async function removeBalanceCheck(id: number): Promise<void> {
  await db.balanceChecks.delete(id)
}
