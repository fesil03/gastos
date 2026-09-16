import { useEffect, useState } from 'react'
import { db } from '../db/db'
import { importWallet, type ImportReport } from '../import/importer'
import type { Group } from '../db/types'
import { formatMinor } from '../lib/money'
import { ensureTaxonomy } from '../db/taxonomy'

interface Summary {
  transactions: number
  categories: number
  groups: Group[]
  byGroup: { name: string; color: string; count: number; totalMinor: number }[]
  first?: string
  last?: string
}

async function loadSummary(): Promise<Summary> {
  const [transactions, categories, groups] = await Promise.all([
    db.transactions.count(),
    db.categories.count(),
    db.groups.orderBy('id').toArray(),
  ])
  const cats = await db.categories.toArray()
  const catGroup = new Map(cats.map((c) => [c.id!, c.groupId]))
  const acc = new Map<number, { count: number; totalMinor: number }>()
  await db.transactions.each((t) => {
    const g = catGroup.get(t.categoryId)
    if (g == null || t.refAmountMinor >= 0) return
    const a = acc.get(g) ?? { count: 0, totalMinor: 0 }
    a.count++
    a.totalMinor += t.refAmountMinor
    acc.set(g, a)
  })
  const byGroup = groups
    .map((g) => ({ name: g.name, color: g.color, ...(acc.get(g.id!) ?? { count: 0, totalMinor: 0 }) }))
    .filter((g) => g.count > 0)
    .sort((a, b) => a.totalMinor - b.totalMinor)
  const first = (await db.transactions.orderBy('date').first())?.date
  const last = (await db.transactions.orderBy('date').last())?.date
  return { transactions, categories, groups, byGroup, first, last }
}

export function ImportScreen() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [pendingCsv, setPendingCsv] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = () => loadSummary().then(setSummary)
  useEffect(() => {
    void refresh()
  }, [])

  async function onFile(file: File) {
    setBusy(true)
    setError(null)
    try {
      const text = await file.text()
      const r = await importWallet(db, text)
      setReport(r)
      setPendingCsv(r.collisions.length ? text : null)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function acceptCollisions() {
    if (!pendingCsv) return
    setBusy(true)
    try {
      const r = await importWallet(db, pendingCsv, { acceptCollisions: true })
      setReport(r)
      setPendingCsv(null)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  async function wipe() {
    setBusy(true)
    try {
      await db.transaction('rw', db.transactions, db.categories, db.groups, db.tags, db.settings, async () => {
        await Promise.all([db.transactions.clear(), db.categories.clear(), db.groups.clear(), db.tags.clear(), db.settings.clear()])
      })
      await ensureTaxonomy(db)
      setReport(null)
      setPendingCsv(null)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mx-auto flex max-w-md flex-col gap-4 px-5">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Importar do Wallet</h2>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <label
          className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-700 px-4 py-8 text-center transition hover:border-slate-500 ${busy ? 'opacity-50' : ''}`}
        >
          <span className="text-base font-medium">{busy ? 'Importando…' : 'Escolher CSV do Wallet'}</span>
          <span className="text-xs text-slate-400">gastos_report_…csv · `;` delimitado · decimais com vírgula</span>
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            disabled={busy}
            data-testid="csv-input"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void onFile(f)
              e.target.value = ''
            }}
          />
        </label>
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      </section>

      {report && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4" data-testid="report">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Relatório</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-slate-400">Linhas lidas</dt>
            <dd className="text-right tabular-nums" data-testid="rows-read">{report.rowsRead}</dd>
            <dt className="text-slate-400">Importadas</dt>
            <dd className="text-right tabular-nums text-emerald-400" data-testid="imported">{report.imported}</dd>
            <dt className="text-slate-400">Já existiam</dt>
            <dd className="text-right tabular-nums" data-testid="skipped">{report.skipped}</dd>
            <dt className="text-slate-400">Categorias criadas</dt>
            <dd className="text-right tabular-nums">{report.categoriesCreated}</dd>
            <dt className="text-slate-400">Erros de parse</dt>
            <dd className="text-right tabular-nums">{report.errors.length}</dd>
            <dt className="text-slate-400">Tempo</dt>
            <dd className="text-right tabular-nums">{report.durationMs} ms</dd>
          </dl>
          {report.untrackedSeeded && (
            <p className="mt-3 rounded-lg bg-slate-800/60 p-3 text-xs text-slate-300" data-testid="untracked-seeded">
              Jan–abr 2025 marcado como <span className="font-medium">sem registro</span> (EUA) — aparece como lacuna nos gráficos, não como zero. Edite em “Períodos sem registro”.
            </p>
          )}

          {report.unmappedEnvelopes.length > 0 && (
            <div className="mt-3 rounded-lg bg-amber-950/40 p-3 text-xs text-amber-200">
              <p className="mb-1 font-medium">Envelopes sem mapeamento → Outros</p>
              <ul>
                {report.unmappedEnvelopes.map((u) => (
                  <li key={`${u.envelopeId}-${u.category}`}>
                    {u.envelopeId ?? '—'} · {u.category} · {u.count}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.errors.length > 0 && (
            <div className="mt-3 max-h-40 overflow-auto rounded-lg bg-red-950/40 p-3 text-xs text-red-200">
              {report.errors.slice(0, 50).map((e) => (
                <p key={e.line}>
                  linha {e.line}: {e.reason}
                </p>
              ))}
            </div>
          )}

          {report.collisions.length > 0 && (
            <div className="mt-3 rounded-lg bg-sky-950/40 p-3 text-xs text-sky-100" data-testid="collisions">
              <p className="mb-2 font-medium">
                {report.collisions.length} duplicata{report.collisions.length > 1 ? 's' : ''} no mesmo segundo — revisar
              </p>
              <ul className="mb-3 max-h-40 space-y-1 overflow-auto">
                {report.collisions.map((c) => (
                  <li key={`${c.hash}-${c.row.line}`} className="flex justify-between gap-2">
                    <span>
                      linha {c.row.line} · {c.row.date.replace('T', ' ')} · {c.row.category}
                    </span>
                    <span className="tabular-nums">{formatMinor(c.row.amountMinor, c.row.currency)}</span>
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <button
                  className="rounded-lg bg-sky-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void acceptCollisions()}
                >
                  Importar mesmo assim
                </button>
                <button className="rounded-lg bg-slate-800 px-3 py-1.5" onClick={() => setPendingCsv(null)}>
                  Ignorar
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {summary && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4" data-testid="summary">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Base local</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-slate-400">Transações</dt>
            <dd className="text-right tabular-nums" data-testid="tx-count">{summary.transactions}</dd>
            <dt className="text-slate-400">Categorias</dt>
            <dd className="text-right tabular-nums" data-testid="cat-count">{summary.categories}</dd>
            <dt className="text-slate-400">Período</dt>
            <dd className="text-right tabular-nums">
              {summary.first ? `${summary.first.slice(0, 10)} → ${summary.last?.slice(0, 10)}` : '—'}
            </dd>
          </dl>
          {summary.byGroup.length > 0 && (
            <ul className="mt-4 space-y-2">
              {summary.byGroup.map((g) => (
                <li key={g.name} className="flex items-center gap-3 text-sm">
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: g.color }} />
                  <span className="flex-1 truncate">{g.name}</span>
                  <span className="text-xs text-slate-500 tabular-nums">{g.count}</span>
                  <span className="w-28 text-right tabular-nums">{formatMinor(g.totalMinor)}</span>
                </li>
              ))}
            </ul>
          )}
          {summary.transactions > 0 && (
            <button
              className="mt-4 text-xs text-slate-500 underline-offset-2 hover:text-red-400 hover:underline"
              disabled={busy}
              onClick={() => {
                if (window.confirm('Apagar toda a base local? Isso não tem volta.')) void wipe()
              }}
            >
              Apagar base local
            </button>
          )}
        </section>
      )}
    </section>
  )
}
