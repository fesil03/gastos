// Data model — spec §5. Money is integers in minor units, dates are local naive ISO.
// Payment method is deliberately NOT tracked (spec §2): one less field on the entry path.

export type TxSource = 'manual' | 'wallet-import'

export interface Transaction {
  id?: number
  amountMinor: number // signed integer, minor units. -14100 = -141.00 CNY
  currency: 'CNY' | 'BRL' | string
  refAmountMinor: number // converted to refCurrency at entry time
  fxRate: number // 1 unit currency -> refCurrency, stored, never re-derived
  date: string // ISO with local time, no zone: '2026-05-02T20:21:39'
  categoryId: number
  tags: number[]
  note?: string
  item?: string // structured note, all optional
  qty?: number
  unitPrice?: number
  source: TxSource
  externalHash?: string // import dedupe, spec §6
  createdAt: string
}

export interface Group {
  id?: number
  name: string
  color: string // hex, used for headline charts
  sortOrder: number
  kind: 'expense' | 'income' | 'other'
}

export interface Category {
  id?: number
  groupId: number
  name: string
  archived: 0 | 1 // Dexie indexes booleans poorly; 0/1 keeps it indexable
  /**
   * Prepaid top-up (spec §3): a campus-card load, not a meal. Counted in every spend total,
   * excluded from ticket-size stats and the time-of-day heatmap, labelled "top-up" in views.
   */
  isTopUp: 0 | 1
  walletEnvelopeId?: number // provenance only — joins are by categoryId, never by name
  walletCustom?: boolean
}

export interface Tag {
  id?: number
  name: string // stored without the leading '#'
}

/** A user-declared range where nothing was logged on purpose (spec §8). Inclusive days. */
export interface UntrackedPeriod {
  id?: number
  start: string // 'YYYY-MM-DD'
  end: string // 'YYYY-MM-DD'
  reason?: string
}

/** A counted cash balance at a point in time (spec §8.1). Two of them yield a capture rate. */
export interface BalanceCheck {
  id?: number
  date: string // local naive ISO
  account: string
  countedMinor: number // in the reference currency
  note?: string
}

export interface Setting {
  key: string
  value: unknown
}

export const DEFAULT_REF_CURRENCY = 'CNY'
export const DEFAULT_ACCOUNT = 'Dinheiro'
