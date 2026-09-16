import { useMemo, useState } from 'react'
import { db } from '../db/db'
import { useAllTransactions, useRefCurrency, useTaxonomy, useUntrackedPeriods } from '../db/hooks'
import { inRange } from '../insights/engine'
import { addMonths, dayKey, monthBounds, monthKey, nowIso } from '../lib/dates'
import { buildBackup, parseBackup, restoreBackup, type Backup, type RestoreReport } from './backup'
import { buildFullCsv, buildMarkdownBundle } from './bundle'
import { canShareFiles, copyText, shareOrDownload } from './deliver'

type Preset = '3m' | '12m' | 'year' | 'all' | 'custom'

export function ExportScreen() {
  const txs = useAllTransactions()
  const taxonomy = useTaxonomy()
  const refCurrency = useRefCurrency()
  const [preset, setPreset] = useState<Preset>('12m')
  const [from, setFrom] = useState(() => monthBounds(addMonths(monthKey(dayKey()), -11))[0])
  const [to, setTo] = useState(() => dayKey())
  const [status, setStatus] = useState<string | null>(null)
  const [pendingRestore, setPendingRestore] = useState<Backup | null>(null)
  const [restoreReport, setRestoreReport] = useState<RestoreReport | null>(null)
  const [busy, setBusy] = useState(false)

  const today = dayKey()
  const range = useMemo((): [string, string] => {
    if (preset === '3m') return [monthBounds(addMonths(monthKey(today), -2))[0], today]
    if (preset === '12m') return [monthBounds(addMonths(monthKey(today), -11))[0], today]
    if (preset === 'year') return [`${today.slice(0, 4)}-01-01`, today]
    if (preset === 'all') return ['0000-01-01', '9999-12-31']
    return [from, to]
  }, [preset, from, to, today])

  const untracked = useUntrackedPeriods() ?? []
  const scoped = useMemo(() => (txs ? inRange(txs, range[0], range[1]) : []), [txs, range])
  const first = txs?.length ? txs.reduce((m, t) => (t.date < m ? t.date : m), txs[0].date).slice(0, 10) : null
  const last = txs?.length ? txs.reduce((m, t) => (t.date > m ? t.date : m), txs[0].date).slice(0, 10) : null

  const bundle = () =>
    buildMarkdownBundle(txs ?? [], taxonomy, {
      fromDay: preset === 'all' ? (first ?? today) : range[0],
      toDay: preset === 'all' ? (last ?? today) : range[1],
      refCurrency,
      generatedAt: nowIso(),
      untracked,
    })
  const stamp = () => today.replace(/-/g, '')
  const flash = (s: string) => {
    setStatus(s)
    setTimeout(() => setStatus(null), 3000)
  }

  const approxKb = useMemo(() => Math.round((scoped.length * 62 + 2500) / 1024), [scoped.length])

  async function onRestoreFile(file: File) {
    try {
      setPendingRestore(parseBackup(await file.text()))
      setRestoreReport(null)
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e))
    }
  }

  async function doRestore(mode: 'replace' | 'merge') {
    if (!pendingRestore) return
    setBusy(true)
    try {
      setRestoreReport(await restoreBackup(db, pendingRestore, mode))
      setPendingRestore(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5 px-4 pb-8 pt-4" data-testid="export-screen">
      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="text-base font-semibold">Colar no Claude</h2>
        <p className="mt-0.5 text-xs text-slate-400">Um arquivo Markdown: esquema, resumo mensal, resumo por categoria e as transações em CSV compacto.</p>

        <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
          {(
            [
              ['3m', '3 meses'],
              ['12m', '12 meses'],
              ['year', 'este ano'],
              ['all', 'tudo'],
              ['custom', 'período…'],
            ] as [Preset, string][]
          ).map(([p, label]) => (
            <button key={p} data-testid={`exp-${p}`} onClick={() => setPreset(p)} className={`rounded-full px-2.5 py-1.5 ${preset === p ? 'bg-slate-700 text-slate-100' : 'bg-slate-800 text-slate-400'}`}>
              {label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="mt-2 flex items-center gap-2 text-xs">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-lg bg-slate-800 px-2 py-1 outline-none" />
            <span className="text-slate-500">→</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-lg bg-slate-800 px-2 py-1 outline-none" />
          </div>
        )}
        <p className="mt-2 text-xs text-slate-500" data-testid="exp-count">
          {scoped.length} transações · ~{approxKb} KB
        </p>

        <div className="mt-3 flex gap-2">
          <button
            data-testid="exp-copy"
            disabled={!txs?.length}
            onClick={async () => flash((await copyText(bundle())) ? 'Copiado — cole no chat.' : 'Não consegui copiar.')}
            className="flex-1 rounded-xl bg-amber-500 py-2.5 text-sm font-semibold text-slate-950 disabled:opacity-40"
          >
            Copiar
          </button>
          <button
            data-testid="exp-share"
            disabled={!txs?.length}
            onClick={async () => {
              const r = await shareOrDownload(`gastos-${stamp()}.md`, bundle(), 'text/markdown')
              if (r !== 'cancelled') flash(r === 'shared' ? 'Compartilhado.' : 'Baixado.')
            }}
            className="flex-1 rounded-xl bg-slate-800 py-2.5 text-sm font-medium disabled:opacity-40"
          >
            {canShareFiles() ? 'Compartilhar .md' : 'Baixar .md'}
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="text-base font-semibold">Backup e planilha</h2>
        <p className="mt-0.5 text-xs text-slate-400">JSON completo (tudo, para restaurar) e CSV com todos os campos (para planilha). Sempre o período inteiro.</p>
        <div className="mt-3 flex gap-2">
          <button
            data-testid="exp-json"
            disabled={!txs?.length}
            onClick={async () => {
              const b = await buildBackup(db, nowIso())
              const r = await shareOrDownload(`gastos-backup-${stamp()}.json`, JSON.stringify(b), 'application/json')
              if (r !== 'cancelled') flash('Backup ' + (r === 'shared' ? 'compartilhado.' : 'baixado.'))
            }}
            className="flex-1 rounded-xl bg-slate-800 py-2.5 text-sm font-medium disabled:opacity-40"
          >
            Backup .json
          </button>
          <button
            data-testid="exp-csv"
            disabled={!txs?.length}
            onClick={async () => {
              const r = await shareOrDownload(`gastos-${stamp()}.csv`, buildFullCsv(txs ?? [], taxonomy), 'text/csv')
              if (r !== 'cancelled') flash('CSV ' + (r === 'shared' ? 'compartilhado.' : 'baixado.'))
            }}
            className="flex-1 rounded-xl bg-slate-800 py-2.5 text-sm font-medium disabled:opacity-40"
          >
            Planilha .csv
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="text-base font-semibold">Restaurar backup</h2>
        <label className="mt-3 flex cursor-pointer items-center justify-center rounded-xl border border-dashed border-slate-700 py-3 text-sm">
          Escolher .json
          <input
            type="file"
            accept=".json,application/json"
            className="hidden"
            data-testid="restore-input"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void onRestoreFile(f)
              e.target.value = ''
            }}
          />
        </label>
        {pendingRestore && (
          <div className="mt-3 rounded-xl bg-slate-800/60 p-3 text-xs" data-testid="restore-pending">
            <p className="mb-2">
              Backup de {pendingRestore.exportedAt.replace('T', ' ')} · {pendingRestore.transactions.length} transações · {pendingRestore.categories.length} categorias
            </p>
            <div className="flex gap-2">
              <button data-testid="restore-merge" disabled={busy} onClick={() => void doRestore('merge')} className="flex-1 rounded-lg bg-amber-500 py-2 font-semibold text-slate-950">
                Mesclar (só o que falta)
              </button>
              <button data-testid="restore-replace" disabled={busy} onClick={() => window.confirm('Substituir TODA a base local pelo backup?') && void doRestore('replace')} className="flex-1 rounded-lg bg-red-900/60 py-2 font-medium text-red-200">
                Substituir tudo
              </button>
            </div>
          </div>
        )}
        {restoreReport && (
          <p className="mt-3 text-xs text-emerald-300" data-testid="restore-report">
            {restoreReport.mode === 'replace' ? 'Base substituída' : 'Mesclado'}: {restoreReport.transactions} transações adicionadas
            {restoreReport.mode === 'merge' ? `, ${restoreReport.skipped} já existiam` : ''}.
          </p>
        )}
      </section>

      {status && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-40 flex justify-center px-4">
          <div className="rounded-full bg-slate-100 px-4 py-2 text-sm text-slate-900 shadow-lg" data-testid="exp-status">
            {status}
          </div>
        </div>
      )}
    </div>
  )
}
