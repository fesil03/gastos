import { useEffect, useReducer, useState } from 'react'
import { db, setSetting } from '../db/db'
import { useSetting } from '../db/hooks'
import { autoPushState, deviceLabel, flush, subscribeAutoPush, withSyncSuspended } from '../sync/autopush'
import { checkRepo, GitHubError, parseRepo } from '../sync/github'
import { DEFAULT_SYNC_PATH, loadConfig, pullSnapshot, pushSnapshot, SYNC_KEYS, type PushResult } from '../sync/snapshot'

type Busy = null | 'test' | 'push' | 'pull'

interface Stamp {
  at: string
  transactions: number
}

/**
 * Sync setup — one direction: this phone writes the snapshot, other devices read it.
 * Sending is automatic because it cannot destroy anything; fetching replaces the whole local
 * database, so it stays a deliberate, confirmed action.
 */
export function SyncCard() {
  const repo = useSetting<string>(SYNC_KEYS.repo, '')
  const path = useSetting<string>(SYNC_KEYS.path, DEFAULT_SYNC_PATH)
  const token = useSetting<string>(SYNC_KEYS.token, '')
  const auto = useSetting<boolean>(SYNC_KEYS.auto, true)
  const lastPush = useSetting<Stamp | null>(SYNC_KEYS.lastPush, null)
  const lastPull = useSetting<Stamp | null>(SYNC_KEYS.lastPull, null)

  const [repoDraft, setRepoDraft] = useState(repo)
  const [tokenDraft, setTokenDraft] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<Busy>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null)
  const [blocked, setBlocked] = useState<PushResult | null>(null)
  const [confirmPull, setConfirmPull] = useState(false)
  const [, bump] = useReducer((x: number) => x + 1, 0)

  useEffect(() => subscribeAutoPush(bump), [])
  useEffect(() => setRepoDraft(repo), [repo])

  const configured = !!repo && !!token
  const say = (kind: 'ok' | 'err' | 'info', text: string) => setMsg({ kind, text })
  const fail = (e: unknown) =>
    say('err', e instanceof GitHubError ? `${e.hint ?? e.message}` : e instanceof Error ? e.message : String(e))

  async function saveConfig() {
    const parsed = parseRepo(repoDraft)
    if (!parsed) return say('err', 'Formato esperado: usuario/repositorio')
    await setSetting(db, SYNC_KEYS.repo, `${parsed.owner}/${parsed.repo}`)
    if (tokenDraft.trim()) {
      await setSetting(db, SYNC_KEYS.token, tokenDraft.trim())
      setTokenDraft('')
    }
    if (!path) await setSetting(db, SYNC_KEYS.path, DEFAULT_SYNC_PATH)
    say('ok', 'Configuração salva.')
  }

  async function test() {
    setBusy('test')
    setMsg(null)
    try {
      const cfg = await loadConfig(db)
      if (!cfg) return say('err', 'Preencha repositório e token primeiro.')
      const info = await checkRepo({ owner: cfg.owner, repo: cfg.repo, path: cfg.path }, cfg.token)
      if (!info.private) say('err', 'Esse repositório é PÚBLICO. Use um privado — o snapshot tem seus gastos.')
      else if (info.permissions?.push === false) say('err', 'O token enxerga o repositório mas não tem permissão de escrita.')
      else say('ok', 'Conexão certa: repositório privado e token com escrita.')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  async function send(force = false) {
    setBusy('push')
    setMsg(null)
    setBlocked(null)
    try {
      const cfg = await loadConfig(db)
      if (!cfg) return say('err', 'Configure repositório e token primeiro.')
      const r = await pushSnapshot(db, cfg, { force, device: deviceLabel() })
      if (r.status === 'blocked') {
        setBlocked(r)
        say('err', r.reason ?? 'Envio bloqueado.')
      } else {
        say('ok', `Enviado: ${r.local.transactions} lançamentos.`)
      }
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  async function fetchNow() {
    setBusy('pull')
    setMsg(null)
    try {
      const cfg = await loadConfig(db)
      if (!cfg) return say('err', 'Configure repositório e token primeiro.')
      const r = await withSyncSuspended(() => pullSnapshot(db, cfg))
      if (r.status === 'empty') say('info', 'Ainda não há snapshot no repositório. Envie do celular primeiro.')
      else say('ok', `Recebido: ${r.transactions} lançamentos (snapshot de ${r.remote?.exportedAt.replace('T', ' ').slice(0, 16)}).`)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
      setConfirmPull(false)
    }
  }

  const statusText =
    autoPushState.status === 'pushing'
      ? 'enviando…'
      : autoPushState.status === 'pending'
        ? 'alterações por enviar'
        : autoPushState.status === 'offline'
          ? 'sem rede — envia quando voltar'
          : autoPushState.status === 'error'
            ? `falhou: ${autoPushState.lastError ?? ''}`
            : lastPush
              ? `último envio: ${lastPush.at.replace('T', ' ').slice(0, 16)} · ${lastPush.transactions} lanç.`
              : 'nada enviado ainda'

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm" data-testid="sync-card">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Sincronização</p>
        <span className={`text-[11px] ${autoPushState.status === 'error' ? 'text-red-400' : 'text-slate-500'}`} data-testid="sync-status">
          {configured ? statusText : 'desligada'}
        </span>
      </div>
      <p className="mb-3 text-[11px] text-slate-500">
        Este aparelho envia uma cópia completa para um repositório privado; os outros buscam essa cópia. Um sentido só: quem busca tem os dados
        locais <span className="text-slate-400">substituídos</span>.
      </p>

      {configured && (
        <div className="mb-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            data-testid="sync-push"
            disabled={busy !== null}
            onClick={() => void send()}
            className="rounded-xl bg-amber-500 py-2.5 text-sm font-semibold text-slate-950 active:scale-95 disabled:opacity-50"
          >
            {busy === 'push' ? 'enviando…' : 'Enviar agora'}
          </button>
          <button
            type="button"
            data-testid="sync-pull"
            disabled={busy !== null}
            onClick={() => setConfirmPull(true)}
            className="rounded-xl bg-slate-800 py-2.5 text-sm font-medium text-slate-200 active:scale-95 disabled:opacity-50"
          >
            {busy === 'pull' ? 'buscando…' : 'Buscar'}
          </button>
        </div>
      )}

      {confirmPull && (
        <div className="mb-3 rounded-xl border border-red-900/60 bg-red-950/30 p-3 text-xs" data-testid="pull-confirm">
          <p className="mb-2 text-red-200">
            Buscar apaga tudo que está neste aparelho e põe o snapshot do repositório no lugar.
            {lastPull && <span className="text-red-300/70"> Última busca: {lastPull.at.replace('T', ' ').slice(0, 16)}.</span>}
          </p>
          <div className="flex gap-2">
            <button type="button" data-testid="pull-confirm-yes" onClick={() => void fetchNow()} className="rounded-lg bg-red-600 px-3 py-1.5 font-medium text-white">
              Substituir
            </button>
            <button type="button" onClick={() => setConfirmPull(false)} className="rounded-lg bg-slate-800 px-3 py-1.5 text-slate-300">
              Cancelar
            </button>
          </div>
        </div>
      )}

      {blocked && (
        <div className="mb-3 rounded-xl border border-amber-900/60 bg-amber-950/30 p-3 text-xs" data-testid="push-blocked">
          <p className="mb-2 text-amber-200">
            {blocked.reason} Enviar assim apagaria a diferença para todos os aparelhos. Só confirme se este aparelho for mesmo o certo.
          </p>
          <div className="flex gap-2">
            <button type="button" data-testid="push-force" onClick={() => void send(true)} className="rounded-lg bg-amber-600 px-3 py-1.5 font-medium text-slate-950">
              Enviar mesmo assim
            </button>
            <button type="button" onClick={() => setBlocked(null)} className="rounded-lg bg-slate-800 px-3 py-1.5 text-slate-300">
              Cancelar
            </button>
          </div>
        </div>
      )}

      {msg && (
        <p
          className={`mb-3 text-xs ${msg.kind === 'ok' ? 'text-emerald-400' : msg.kind === 'err' ? 'text-red-400' : 'text-slate-300'}`}
          data-testid="sync-msg"
        >
          {msg.text}
        </p>
      )}

      <button type="button" data-testid="sync-toggle-config" onClick={() => setOpen((v) => !v)} className="text-[11px] text-slate-500 underline-offset-2 hover:underline">
        {open ? 'esconder configuração' : configured ? 'alterar configuração' : 'configurar…'}
      </button>

      {open && (
        <div className="mt-3 space-y-2">
          <label className="block text-[11px] text-slate-400">
            Repositório privado
            <input
              value={repoDraft}
              onChange={(e) => setRepoDraft(e.target.value)}
              placeholder="usuario/gastos-dados"
              data-testid="sync-repo"
              className="mt-1 w-full rounded-xl bg-slate-800 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600"
            />
          </label>
          <label className="block text-[11px] text-slate-400">
            Token {token && <span className="text-slate-600">· já guardado neste aparelho</span>}
            <input
              type="password"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              placeholder={token ? '•••••••• (deixe vazio para manter)' : 'github_pat_…'}
              autoComplete="off"
              data-testid="sync-token"
              className="mt-1 w-full rounded-xl bg-slate-800 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600"
            />
          </label>
          <label className="flex items-center gap-2 text-[11px] text-slate-400">
            <input
              type="checkbox"
              checked={auto}
              data-testid="sync-auto"
              onChange={(e) => void setSetting(db, SYNC_KEYS.auto, e.target.checked)}
            />
            Enviar automaticamente após cada alteração
          </label>
          <div className="flex gap-2 pt-1">
            <button type="button" data-testid="sync-save" onClick={() => void saveConfig()} className="rounded-xl bg-slate-700 px-4 py-2 text-xs font-medium text-slate-100">
              Salvar
            </button>
            <button
              type="button"
              data-testid="sync-test"
              disabled={busy !== null || !configured}
              onClick={() => void test()}
              className="rounded-xl bg-slate-800 px-4 py-2 text-xs text-slate-300 disabled:opacity-50"
            >
              {busy === 'test' ? 'testando…' : 'Testar conexão'}
            </button>
            {configured && (
              <button
                type="button"
                onClick={() => void flush(db, { force: true })}
                className="ml-auto rounded-xl px-2 py-2 text-[11px] text-slate-500 underline-offset-2 hover:underline"
              >
                forçar envio
              </button>
            )}
          </div>
          <p className="pt-1 text-[11px] leading-relaxed text-slate-600">
            O token fica guardado neste aparelho, em texto simples, como qualquer app que salva login. Use um token{' '}
            <span className="text-slate-500">fine-grained</span> limitado a esse único repositório, com permissão de Contents: read and write — e
            revogue-o se perder o aparelho.
          </p>
        </div>
      )}
    </div>
  )
}
