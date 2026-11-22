// Backtest the month-end projection against real months.
// Usage: npx tsx scripts/backtest-projection.ts <export-bundle.md> [untrackedStart:untrackedEnd ...]
// The bundle is a Gastos "paste into Claude" export; it is read, never copied into the repo.
import { readFileSync } from 'node:fs'
import Papa from 'papaparse'
import type { Transaction, UntrackedPeriod } from '../src/db/types'
import { monthlyStats } from '../src/insights/engine'
import { historyMonths, projectMonth } from '../src/insights/projection'
import { monthBounds } from '../src/lib/dates'

const [file, ...periods] = process.argv.slice(2)
const md = readFileSync(file, 'utf8')
const csv = md.split('```csv\n')[1].split('```')[0]
const rows = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true }).data
const catIds = new Map<string, number>()
const txs: Transaction[] = rows.map((r, i) => {
  if (!catIds.has(r.category)) catIds.set(r.category, catIds.size + 1)
  const minor = Math.round(Number(r.amount) * 100)
  return { id: i + 1, amountMinor: minor, refAmountMinor: minor, currency: r.currency, fxRate: 1, date: r.date, categoryId: catIds.get(r.category)!, tags: [], source: 'manual', createdAt: r.date }
})
const topUpIds = new Set([catIds.get('Cantina')!])
const untracked: UntrackedPeriod[] = periods.map((p) => ({ start: p.split(':')[0], end: p.split(':')[1] }))
const stats = monthlyStats(txs, { untracked })
const totals = new Map(stats.map((m) => [m.month, m.totalMinor]))
const p2 = (n: number) => String(n).padStart(2, '0')

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2 }
const buckets: Record<string, number[]> = { 'days 1-10': [], 'days 11-20': [], 'days 21-end': [] }
const signed: number[] = []
const months = historyMonths(stats, process.env.BEFORE ?? '2026-11')
console.log('history-eligible months:', months.map((m) => m.month).join(' '))
for (const h of months) {
  const last = Number(monthBounds(h.month)[1].slice(8, 10))
  const actual = totals.get(h.month)!
  const row: string[] = []
  for (let d = 1; d < last; d++) {
    const p = projectMonth(txs, { month: h.month, asOf: `${h.month}-${p2(d)}`, untracked, topUpIds, stats, includeScheduled: false, backtest: false, inferAway: process.env.AWAY !== '0' })
    if (p.method !== 'trend') continue
    const err = (p.projectedMinor - actual) / actual
    signed.push(err)
    buckets[d <= 10 ? 'days 1-10' : d <= 20 ? 'days 11-20' : 'days 21-end'].push(Math.abs(err))
    if (d % 5 === 0) row.push(`d${d}:${(err * 100).toFixed(0)}%`)
  }
  console.log(h.month, 'actual', (actual / 100).toFixed(0), row.join(' '))
}
for (const [k, v] of Object.entries(buckets)) console.log(k, 'median |error|', v.length ? (median(v) * 100).toFixed(1) + '%' : '—', `(n=${v.length})`)
console.log('bias (median signed error)', (median(signed) * 100).toFixed(1) + '%', '· overall median |error|', (median(signed.map(Math.abs)) * 100).toFixed(1) + '%')
