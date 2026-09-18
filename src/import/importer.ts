import type { GastosDB } from '../db/db'
import { getSetting, setSetting } from '../db/db'
import { ensureCategory, ensureTaxonomy, groupForEnvelope } from '../db/taxonomy'
import { DEFAULT_REF_CURRENCY, type Transaction, type UntrackedPeriod } from '../db/types'
import { externalHash, parseStructuredNote, parseWalletCsv, type ParseError, type WalletRow } from './wallet'

// One-shot Wallet CSV importer, re-runnable for newer exports — spec §6.

/**
 * Spec §8: the Jan–Apr 2025 gap in the export is deliberate (user was in the US, not tracking).
 * Seeded once, on the first import whose data spans that gap; never re-added if the user removes it.
 */
export const SEED_UNTRACKED: Omit<UntrackedPeriod, 'id'> = { start: '2025-01-01', end: '2025-04-30', reason: 'EUA, sem registrar' }

export interface Collision {
  row: WalletRow
  hash: string
  /** How many rows with this hash already exist (in the DB plus earlier in this file). */
  existing: number
}

export interface ImportReport {
  rowsRead: number
  imported: number
  skipped: number // already present (idempotent re-run)
  collisions: Collision[] // in-file duplicates held back for review
  unmappedEnvelopes: { envelopeId: number | null; category: string; count: number }[]
  categoriesCreated: number
  untrackedSeeded: boolean
  errors: ParseError[]
  durationMs: number
}

export interface ImportOptions {
  /** Import in-file duplicates instead of holding them for review. */
  acceptCollisions?: boolean
  onProgress?: (done: number, total: number) => void
}

export async function importWallet(db: GastosDB, csvText: string, opts: ImportOptions = {}): Promise<ImportReport> {
  const t0 = Date.now()
  const { rows, errors } = parseWalletCsv(csvText)

  const report: ImportReport = {
    rowsRead: rows.length,
    imported: 0,
    skipped: 0,
    collisions: [],
    unmappedEnvelopes: [],
    categoriesCreated: 0,
    untrackedSeeded: false,
    errors,
    durationMs: 0,
  }
  if (rows.length === 0) {
    report.durationMs = Date.now() - t0
    return report
  }

  // 1. Hashes — async crypto must finish before we open the Dexie transaction.
  const hashes = await Promise.all(rows.map((r) => externalHash(r.date, r.amountMinor, r.currency, r.category)))

  // 2. Taxonomy: seed groups/tags, then find-or-create every category in the file.
  const groupIds = await ensureTaxonomy(db)
  const categoryIdByName = new Map<string, number>()
  const unmapped = new Map<string, { envelopeId: number | null; category: string; count: number }>()
  const before = await db.categories.count()

  for (const r of rows) {
    const { group, mapped } = groupForEnvelope(r.envelopeId)
    if (!mapped) {
      const key = `${r.envelopeId}|${r.category}`
      const u = unmapped.get(key) ?? { envelopeId: r.envelopeId, category: r.category, count: 0 }
      u.count++
      unmapped.set(key, u)
    }
    if (!categoryIdByName.has(r.category)) {
      const id = await ensureCategory(db, r.category, groupIds.get(group)!, {
        walletEnvelopeId: r.envelopeId ?? undefined,
        walletCustom: r.customCategory,
      })
      categoryIdByName.set(r.category, id)
    }
  }
  report.categoriesCreated = (await db.categories.count()) - before
  report.unmappedEnvelopes = [...unmapped.values()].sort((a, b) => b.count - a.count)

  // 3. Dedupe. For a hash with m copies in the DB and k in the file, copies 1..m are
  //    "skipped", the first copy beyond m is new, and any further copies are collisions
  //    (imported only when explicitly accepted). This keeps re-runs idempotent even after
  //    a user has accepted genuine same-second duplicates.
  const existingCounts = new Map<string, number>()
  const unique = [...new Set(hashes)]
  const CHUNK = 500
  for (let i = 0; i < unique.length; i += CHUNK) {
    const found = await db.transactions.where('externalHash').anyOf(unique.slice(i, i + CHUNK)).toArray()
    for (const t of found) existingCounts.set(t.externalHash!, (existingCounts.get(t.externalHash!) ?? 0) + 1)
  }

  const seenInFile = new Map<string, number>()
  const toInsert: Transaction[] = []
  const createdAt = localNowIso()

  rows.forEach((r, i) => {
    const h = hashes[i]
    const occurrence = (seenInFile.get(h) ?? 0) + 1
    seenInFile.set(h, occurrence)
    const inDb = existingCounts.get(h) ?? 0

    if (occurrence <= inDb) {
      report.skipped++
      return
    }
    if (occurrence > 1 && !opts.acceptCollisions) {
      // Same hash appeared earlier in this file → hold for review.
      report.collisions.push({ row: r, hash: h, existing: occurrence - 1 })
      return
    }
    toInsert.push(toTransaction(r, categoryIdByName.get(r.category)!, h, createdAt))
    opts.onProgress?.(i + 1, rows.length)
  })

  // 4. Write in one transaction.
  if (toInsert.length) {
    await db.transaction('rw', db.transactions, async () => {
      await db.transactions.bulkAdd(toInsert)
    })
  }
  report.imported = toInsert.length

  // Wallet's reference currency in this export is CNY (every CNY row has ref == amount).
  // Set refCurrency on first import if the user hasn't chosen one.
  if (!(await db.settings.get('refCurrency'))) {
    await setSetting(db, 'refCurrency', await getSetting(db, 'refCurrency', DEFAULT_REF_CURRENCY))
  }
  await setSetting(db, 'lastWalletImport', { at: createdAt, rowsRead: rows.length, imported: report.imported })

  // Seed the declared untracked period once the imported history spans it.
  const dates = rows.map((r) => r.date)
  const spansGap = dates.some((d) => d < SEED_UNTRACKED.start) && dates.some((d) => d > `${SEED_UNTRACKED.end}T23:59:59`)
  if (spansGap && !(await getSetting(db, 'untrackedSeeded', false))) {
    await db.untrackedPeriods.add({ ...SEED_UNTRACKED })
    await setSetting(db, 'untrackedSeeded', true)
    report.untrackedSeeded = true
  }

  report.durationMs = Date.now() - t0
  return report
}

function toTransaction(r: WalletRow, categoryId: number, hash: string, createdAt: string): Transaction {
  const structured = parseStructuredNote(r.note)
  const tx: Transaction = {
    amountMinor: r.amountMinor,
    currency: r.currency,
    refAmountMinor: r.refAmountMinor,
    fxRate: r.fxRate,
    date: r.date,
    categoryId,
    tags: [],
    source: 'wallet-import',
    externalHash: hash,
    createdAt,
  }
  if (r.timeUnknown) tx.timeUnknown = 1
  if (r.note) tx.note = r.note
  if (structured.item) tx.item = structured.item
  if (structured.qty != null) tx.qty = structured.qty
  if (structured.unitPrice != null) tx.unitPrice = structured.unitPrice
  return tx
}

/** Local wall-clock time as naive ISO — never .toISOString() (that would be UTC). */
export function localNowIso(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
