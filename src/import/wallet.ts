import Papa from 'papaparse'

// Wallet by BudgetBakers CSV — parsing primitives (spec §2, §6).
// Semicolon-delimited, comma-decimal, quoted-field-safe. Never String.split.
// Dropped on purpose (spec §6): gps_*, payee, labels, warranty_in_month, transfer,
// payment_type_local, payment_type — all empty or constant, none tracked here.

export interface WalletRow {
  line: number // 1-based line in the file (header is line 1)
  account: string
  category: string
  currency: string
  amountMinor: number
  refAmountMinor: number
  fxRate: number
  type: 'Despesas' | 'Receita' | string
  note?: string
  date: string // local naive ISO
  envelopeId: number | null
  customCategory: boolean
}

export interface ParseError {
  line: number
  reason: string
}

const REQUIRED_COLUMNS = ['category', 'currency', 'amount', 'ref_currency_amount', 'date', 'envelope_id'] as const

/** "-1.234,56" → -123456. String arithmetic only; floats never touch money. */
export function parseAmountMinor(raw: string | undefined | null): number | null {
  if (raw == null) return null
  let s = raw.trim().replace(/\s/g, '')
  if (!s) return null
  // Portuguese format: '.' thousands, ',' decimal. If there's no comma but exactly one dot
  // with ≤2 trailing digits, treat the dot as a decimal point (defensive, not observed in export).
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.')
  }
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(s)
  if (!m) return null
  const sign = m[1] === '-' ? -1 : 1
  const whole = m[2]
  let frac = m[3] ?? ''
  let carry = 0
  if (frac.length > 2) {
    carry = Number(frac[2]) >= 5 ? 1 : 0
    frac = frac.slice(0, 2)
  }
  frac = frac.padEnd(2, '0')
  const minor = Number(whole) * 100 + Number(frac) + carry
  if (!Number.isSafeInteger(minor)) return null
  return sign * minor
}

/** "2026-05-02 20:21:39" → "2026-05-02T20:21:39". No Date object, no timezone. */
export function parseWalletDate(raw: string | undefined | null): string | null {
  if (!raw) return null
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(raw.trim())
  return m ? `${m[1]}T${m[2]}` : null
}

/**
 * Best-effort structured note. Recognised shapes (never blocks import):
 *   "Abacaxi, 1.47kg, 25.60元/kg"  → item Abacaxi, qty 1.47, unitPrice 25.60
 *   "10x Cafe" / "21x café"        → item Cafe, qty 10
 *   "Fruta, 2x caixinha de melancia" → item Fruta, qty 2
 */
export function parseStructuredNote(note: string | undefined): { item?: string; qty?: number; unitPrice?: number } {
  if (!note) return {}
  const s = note.trim()

  const kg = /^([^,]+),\s*([\d.,]+)\s*(?:kg|g|l|ml|un|x)?\s*,\s*([\d.,]+)\s*(?:元|¥|R\$|\$)?(?:\/\w+)?\s*$/i.exec(s)
  if (kg) {
    const qty = toNumber(kg[2])
    const unitPrice = toNumber(kg[3])
    const out: { item?: string; qty?: number; unitPrice?: number } = { item: kg[1].trim() }
    if (qty != null) out.qty = qty
    if (unitPrice != null) out.unitPrice = unitPrice
    return out
  }

  const times = /^(\d+(?:[.,]\d+)?)\s*x\s+(.+)$/i.exec(s)
  if (times) {
    const qty = toNumber(times[1])
    return qty != null ? { item: times[2].trim(), qty } : {}
  }

  const itemTimes = /^([^,]+),\s*(\d+(?:[.,]\d+)?)\s*x\s+.+$/i.exec(s)
  if (itemTimes) {
    const qty = toNumber(itemTimes[2])
    return qty != null ? { item: itemTimes[1].trim(), qty } : {}
  }

  return {}
}

function toNumber(s: string): number | null {
  const n = Number(s.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

/** sha256(date + amount + currency + category) as lowercase hex — spec §6 dedupe key. */
export async function externalHash(date: string, amountMinor: number, currency: string, category: string): Promise<string> {
  const input = `${date}|${amountMinor}|${currency}|${category}`
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function parseWalletCsv(text: string): { rows: WalletRow[]; errors: ParseError[] } {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), {
    delimiter: ';',
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  })

  const rows: WalletRow[] = []
  const errors: ParseError[] = []

  const fields = parsed.meta.fields ?? []
  const missing = REQUIRED_COLUMNS.filter((c) => !fields.includes(c))
  if (missing.length) {
    return { rows, errors: [{ line: 1, reason: `missing columns: ${missing.join(', ')}` }] }
  }

  for (const e of parsed.errors) {
    // PapaParse reports row index (0-based, excluding header); TooFewFields on a trailing line is benign.
    if (e.code === 'TooFewFields' || e.code === 'TooManyFields') continue
    errors.push({ line: (e.row ?? -2) + 2, reason: `${e.code}: ${e.message}` })
  }

  parsed.data.forEach((r, i) => {
    const line = i + 2
    const amountMinor = parseAmountMinor(r.amount)
    if (amountMinor == null) return errors.push({ line, reason: `bad amount "${r.amount}"` })
    const refRaw = parseAmountMinor(r.ref_currency_amount)
    const refAmountMinor = refRaw ?? amountMinor
    const date = parseWalletDate(r.date)
    if (!date) return errors.push({ line, reason: `bad date "${r.date}"` })
    const category = (r.category ?? '').trim()
    if (!category) return errors.push({ line, reason: 'empty category' })
    const currency = (r.currency ?? '').trim().toUpperCase()
    if (!currency) return errors.push({ line, reason: 'empty currency' })

    const envRaw = (r.envelope_id ?? '').trim()
    const envelopeId = /^\d+$/.test(envRaw) ? Number(envRaw) : null
    const note = (r.note ?? '').trim()

    // fxRate = ref / amount, guard divide-by-zero. Both in minor units so the ratio is unit-free.
    const fxRate = amountMinor === 0 ? 1 : refAmountMinor / amountMinor

    rows.push({
      line,
      account: (r.account ?? '').trim(),
      category,
      currency,
      amountMinor,
      refAmountMinor,
      fxRate,
      type: (r.type ?? '').trim(),
      note: note || undefined,
      date,
      envelopeId,
      customCategory: (r.custom_category ?? '').trim().toLowerCase() === 'true',
    })
  })

  return { rows, errors }
}
