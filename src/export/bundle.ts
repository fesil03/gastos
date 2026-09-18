import Papa from 'papaparse'
import type { Category, Group, Tag, Transaction, UntrackedPeriod } from '../db/types'
import { categoryBreakdown, lacksTime, monthlyStats } from '../insights/engine'
import { inRange } from '../insights/engine'

// LLM export bundle — spec §9. One Markdown file, four sections, readable in a chat window.

export interface ExportTaxonomy {
  categoryById: Map<number, Category>
  groupById: Map<number, Group>
  tagById: Map<number, Tag>
}

export interface BundleOptions {
  fromDay: string
  toDay: string
  refCurrency: string
  generatedAt: string // local naive ISO
  /** Declared untracked periods (spec §8) — rendered as coverage 'untracked', distinct from 'incomplete'. */
  untracked?: UntrackedPeriod[]
}

/** Minor units → "123.45" with a decimal point and sign, no thousands separators. */
export function decimal(minor: number): string {
  const neg = minor < 0
  const abs = Math.abs(minor)
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

export function buildMarkdownBundle(all: Transaction[], tax: ExportTaxonomy, opts: BundleOptions): string {
  const txs = inRange(all, opts.fromDay, opts.toDay).sort((a, b) => a.date.localeCompare(b.date))
  const stats = monthlyStats(all, { untracked: opts.untracked }).filter((m) => `${m.month}-01` <= opts.toDay && m.month >= opts.fromDay.slice(0, 7))
  const incomplete = stats.filter((m) => m.coverage === 'incomplete').map((m) => m.month)
  const untrackedMonths = stats.filter((m) => m.coverage === 'untracked').map((m) => m.month)
  const topUps = [...tax.categoryById.values()].filter((c) => c.isTopUp === 1).map((c) => c.name)
  const catName = (id: number) => tax.categoryById.get(id)?.name ?? '—'
  const groupName = (id: number) => {
    const c = tax.categoryById.get(id)
    return (c && tax.groupById.get(c.groupId)?.name) ?? 'Outros'
  }
  const currencies = [...new Set(txs.map((t) => t.currency))]
  const expenses = txs.filter((t) => t.refAmountMinor < 0)
  const total = expenses.reduce((s, t) => s - t.refAmountMinor, 0)

  const lines: string[] = []
  lines.push(`# Gastos — export ${opts.fromDay} → ${opts.toDay}`)
  lines.push('')
  lines.push('## 1. Schema')
  lines.push('')
  lines.push(`- Personal expense log of one person; ${txs.length} transactions (${expenses.length} expenses, ${txs.length - expenses.length} income) from ${opts.fromDay} to ${opts.toDay}, generated ${opts.generatedAt.replace('T', ' ')}.`)
  lines.push(`- Amounts are signed decimals; negative = expense, positive = income. \`currency\` is the original currency (${currencies.join(', ')}); all rollups below are in the reference currency **${opts.refCurrency}**, converted at the rate stored when each transaction was logged.`)
  const noTime = txs.filter(lacksTime).length
  lines.push(
    `- Dates are local wall-clock time where the transaction happened (ISO, no timezone). Hour-of-day is meaningful` +
      (noTime ? `, except for ${noTime} row${noTime === 1 ? '' : 's'} stamped inside the midnight minute (00:00:00–00:00:59), where the time was never recorded — use their dates but ignore their hour.` : '.'),
  )
  lines.push(
    `- Taxonomy: each transaction has one \`category\` which belongs to one \`group\`; \`tags\` are optional, pipe-separated. Category names are in Portuguese.` +
      (topUps.length
        ? ` **Top-up categories** (${topUps.join(', ')}) are prepaid card loads, not purchases: keep them in spend totals, but leave them out of ticket-size and time-of-day analyses.`
        : ''),
  )
  const coverageParts: string[] = []
  if (untrackedMonths.length) coverageParts.push(`**untracked** months (${untrackedMonths.join(', ')}) were deliberately not logged — treat them as missing data, never as zero spend, and never average them in`)
  if (incomplete.length) coverageParts.push(`**incomplete** months (${incomplete.join(', ')}) have too few entries to compare (below 40% of the trailing median) — treat their totals as under-reported, not as low spending`)
  lines.push(coverageParts.length ? `- Coverage: ${coverageParts.join('; ')}.` : `- Coverage: every month in range has normal logging density; no month is flagged.`)
  lines.push('')

  lines.push('## 2. Monthly rollup')
  lines.push('')
  lines.push(`| month | txns | total ${opts.refCurrency} | top-3 categories | coverage |`)
  lines.push('|---|---:|---:|---|---|')
  for (const m of stats) {
    const top = m.topCategories.map((c) => `${catName(c.categoryId)} ${decimal(c.totalMinor)}`).join('; ')
    lines.push(`| ${m.month} | ${m.count} | ${decimal(m.totalMinor)} | ${top || '—'} | ${m.coverage} |`)
  }
  lines.push(`| **total** | **${expenses.length}** | **${decimal(total)}** | | |`)
  lines.push('')

  lines.push('## 3. Category rollup')
  lines.push('')
  lines.push(`| category | group | txns | total ${opts.refCurrency} | share | mean ticket |`)
  lines.push('|---|---|---:|---:|---:|---:|')
  for (const c of categoryBreakdown(txs)) {
    const label = tax.categoryById.get(c.id)?.isTopUp === 1 ? `${catName(c.id)} (top-up)` : catName(c.id)
    lines.push(`| ${label} | ${groupName(c.id)} | ${c.count} | ${decimal(c.totalMinor)} | ${(c.share * 100).toFixed(1)}% | ${decimal(c.meanMinor)} |`)
  }
  lines.push('')

  lines.push('## 4. Transactions')
  lines.push('')
  lines.push('```csv')
  lines.push(buildCompactCsv(txs, tax))
  lines.push('```')
  lines.push('')
  return lines.join('\n')
}

/** Compact CSV: comma-delimited, ISO dates, decimal points, empty columns dropped. */
export function buildCompactCsv(txs: Transaction[], tax: ExportTaxonomy): string {
  const catName = (id: number) => tax.categoryById.get(id)?.name ?? ''
  const groupName = (id: number) => {
    const c = tax.categoryById.get(id)
    return (c && tax.groupById.get(c.groupId)?.name) ?? ''
  }
  const rows = txs.map((t) => ({
    date: t.date,
    amount: decimal(t.amountMinor),
    currency: t.currency,
    category: catName(t.categoryId),
    group: groupName(t.categoryId),
    tags: t.tags.map((id) => tax.tagById.get(id)?.name).filter(Boolean).join('|'),
    note: t.note ?? '',
  }))
  const columns = (['date', 'amount', 'currency', 'category', 'group', 'tags', 'note'] as const).filter((c) => rows.some((r) => r[c] !== ''))
  return Papa.unparse(rows, { columns: columns as unknown as string[], newline: '\n' })
}

/** Plain full CSV — every stored field, for spreadsheets. */
export function buildFullCsv(txs: Transaction[], tax: ExportTaxonomy): string {
  const rows = txs
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((t) => {
      const c = tax.categoryById.get(t.categoryId)
      return {
        id: t.id ?? '',
        date: t.date,
        amount: decimal(t.amountMinor),
        currency: t.currency,
        ref_amount: decimal(t.refAmountMinor),
        fx_rate: t.fxRate,
        category: c?.name ?? '',
        group: (c && tax.groupById.get(c.groupId)?.name) ?? '',
        tags: t.tags.map((id) => tax.tagById.get(id)?.name).filter(Boolean).join('|'),
        note: t.note ?? '',
        item: t.item ?? '',
        qty: t.qty ?? '',
        unit_price: t.unitPrice ?? '',
        top_up: c?.isTopUp === 1 ? 'yes' : '',
        source: t.source,
        created_at: t.createdAt,
      }
    })
  return Papa.unparse(rows, { newline: '\n' })
}
