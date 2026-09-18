import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { GastosDB, setSetting } from '../db/db'
import { ensureCategory, ensureTaxonomy } from '../db/taxonomy'
import { base64ToUtf8, parseRepo, utf8ToBase64, GitHubError, getFile, putFile } from './github'
import { pullSnapshot, pushSnapshot, loadConfig, SYNC_KEYS, DEFAULT_SYNC_PATH, type SyncConfig } from './snapshot'
import { buildBackup } from '../export/backup'

const CFG: SyncConfig = { owner: 'felipe', repo: 'gastos-dados', path: DEFAULT_SYNC_PATH, token: 'tok' }

describe('parseRepo', () => {
  it('accepts the shapes a person actually types', () => {
    expect(parseRepo('felipe/gastos-dados')).toEqual({ owner: 'felipe', repo: 'gastos-dados' })
    expect(parseRepo('  felipe/gastos-dados  ')).toEqual({ owner: 'felipe', repo: 'gastos-dados' })
    expect(parseRepo('https://github.com/felipe/gastos-dados')).toEqual({ owner: 'felipe', repo: 'gastos-dados' })
    expect(parseRepo('https://github.com/felipe/gastos-dados.git')).toEqual({ owner: 'felipe', repo: 'gastos-dados' })
    expect(parseRepo('felipe')).toBeNull()
    expect(parseRepo('a/b/c')).toBeNull()
    expect(parseRepo('')).toBeNull()
  })
})

describe('base64 helpers', () => {
  it('round-trip survives the accents and CJK in this data', () => {
    const s = JSON.stringify({ a: 'Alimentação · Táxi · Álcool', b: '25.60元/kg', c: '林亦洲', d: '—' })
    expect(base64ToUtf8(utf8ToBase64(s))).toBe(s)
  })
  it('handles a payload larger than one chunk', () => {
    const s = 'Café ' .repeat(50_000)
    expect(base64ToUtf8(utf8ToBase64(s))).toBe(s)
  })
})

// ---- fake GitHub -------------------------------------------------------------
let remote: { text: string; sha: string } | null
let calls: { method: string; url: string }[]

function installFetch(opts: { status?: number } = {}) {
  calls = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url: String(url) })
    if (opts.status) return new Response(JSON.stringify({ message: 'nope' }), { status: opts.status })
    if (String(url).includes('/contents/')) {
      if (method === 'GET') {
        if (!remote) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
        return new Response(JSON.stringify({ content: utf8ToBase64(remote.text), sha: remote.sha, encoding: 'base64' }), { status: 200 })
      }
      const body = JSON.parse(String(init!.body)) as { content: string; sha?: string }
      if (remote && body.sha !== remote.sha) return new Response(JSON.stringify({ message: 'conflict' }), { status: 409 })
      remote = { text: base64ToUtf8(body.content), sha: `sha${(calls.length)}` }
      return new Response(JSON.stringify({ content: { sha: remote.sha } }), { status: 200 })
    }
    return new Response(JSON.stringify({ private: true, permissions: { push: true } }), { status: 200 })
  })
}

async function seeded(n: number, name = `s-${Math.random()}`): Promise<GastosDB> {
  const db = new GastosDB(name)
  const groups = await ensureTaxonomy(db)
  const cat = await ensureCategory(db, 'Café', groups.get('Alimentação')!)
  for (let i = 0; i < n; i++) {
    await db.transactions.add({
      amountMinor: -(i + 1) * 100, currency: 'CNY', refAmountMinor: -(i + 1) * 100, fxRate: 1,
      date: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T12:00:0${i % 10}`,
      categoryId: cat, tags: [], source: 'manual', createdAt: '2026-09-18T12:00:00',
    })
  }
  return db
}

beforeEach(() => { remote = null })
afterEach(() => vi.unstubAllGlobals())

describe('pushSnapshot', () => {
  it('creates the file on first push and replaces it afterwards', async () => {
    installFetch()
    const db = await seeded(5)
    const a = await pushSnapshot(db, CFG, { device: 'Android' })
    expect(a.status).toBe('pushed')
    expect(a.local.transactions).toBe(5)
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1)
    expect(JSON.parse(remote!.text).transactions).toHaveLength(5)
    expect(JSON.parse(remote!.text).device).toBe('Android')

    const b = await pushSnapshot(db, CFG)
    expect(b.status).toBe('pushed')
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2)
  })

  it('refuses to overwrite a bigger snapshot — the laptop-clobbers-phone accident', async () => {
    installFetch()
    const phone = await seeded(40)
    await pushSnapshot(phone, CFG, { device: 'Android' })
    const before = remote!.text

    const laptop = await seeded(3)
    const r = await pushSnapshot(laptop, CFG, { device: 'Mac' })
    expect(r.status).toBe('blocked')
    expect(r.remote!.transactions).toBe(40)
    expect(r.local.transactions).toBe(3)
    expect(r.reason).toContain('40')
    expect(remote!.text).toBe(before) // untouched
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1)
  })

  it('force overrides the guard, deliberately', async () => {
    installFetch()
    await pushSnapshot(await seeded(40), CFG)
    const r = await pushSnapshot(await seeded(3), CFG, { force: true })
    expect(r.status).toBe('pushed')
    expect(JSON.parse(remote!.text).transactions).toHaveLength(3)
  })

  it('an equal or larger snapshot passes without force', async () => {
    installFetch()
    await pushSnapshot(await seeded(10), CFG)
    expect((await pushSnapshot(await seeded(10), CFG)).status).toBe('pushed')
    expect((await pushSnapshot(await seeded(11), CFG)).status).toBe('pushed')
  })

  it('an unreadable remote file does not block the push', async () => {
    installFetch()
    remote = { text: 'not json at all', sha: 'x' }
    expect((await pushSnapshot(await seeded(2), CFG)).status).toBe('pushed')
  })
})

describe('pullSnapshot', () => {
  it('replaces local data with the snapshot', async () => {
    installFetch()
    const phone = await seeded(12)
    await pushSnapshot(phone, CFG, { device: 'Android' })

    const laptop = await seeded(2)
    expect(await laptop.transactions.count()).toBe(2)
    const r = await pullSnapshot(laptop, CFG)
    expect(r.status).toBe('pulled')
    expect(r.transactions).toBe(12)
    expect(await laptop.transactions.count()).toBe(12)
  })

  it('reports an empty repo instead of wiping the device', async () => {
    installFetch()
    const laptop = await seeded(4)
    const r = await pullSnapshot(laptop, CFG)
    expect(r.status).toBe('empty')
    expect(await laptop.transactions.count()).toBe(4)
  })

  it('a corrupt snapshot throws and leaves local data alone', async () => {
    installFetch()
    remote = { text: '{"format":"something-else"}', sha: 'x' }
    const laptop = await seeded(4)
    await expect(pullSnapshot(laptop, CFG)).rejects.toThrow()
    expect(await laptop.transactions.count()).toBe(4)
  })

  it('round-trips the tables the backup format carries', async () => {
    installFetch()
    const phone = await seeded(3)
    await phone.untrackedPeriods.add({ start: '2025-01-01', end: '2025-04-30', reason: 'EUA' })
    await phone.balanceChecks.add({ date: '2026-09-01T10:00:00', account: 'Dinheiro', countedMinor: 120000 })
    await setSetting(phone, 'refCurrency', 'CNY')
    await pushSnapshot(phone, CFG)

    const laptop = await seeded(0)
    await pullSnapshot(laptop, CFG)
    expect(await laptop.untrackedPeriods.count()).toBe(1)
    expect(await laptop.balanceChecks.count()).toBe(1)
    expect((await laptop.settings.get('refCurrency'))!.value).toBe('CNY')
  })
})

describe('errors are explained, not raw', () => {
  it.each([
    [401, 'Token inválido'],
    [403, 'sem permissão'],
  ])('HTTP %i on read carries a hint', async (status, fragment) => {
    installFetch({ status })
    await expect(getFile({ owner: 'a', repo: 'b', path: 'c' }, 'tok')).rejects.toSatisfy(
      (e: unknown) => e instanceof GitHubError && !!e.hint?.includes(fragment),
    )
  })
  it.each([
    [401, 'Token inválido'],
    [403, 'sem permissão'],
    [404, 'não encontrado'],
  ])('HTTP %i on write carries a hint', async (status, fragment) => {
    installFetch({ status })
    await expect(putFile({ owner: 'a', repo: 'b', path: 'c' }, 'tok', '{}', undefined, 'm')).rejects.toSatisfy(
      (e: unknown) => e instanceof GitHubError && !!e.hint?.includes(fragment),
    )
  })
  it('a 404 on read means "no file yet", not an error — that is how the first push works', async () => {
    installFetch()
    expect(await getFile({ owner: 'a', repo: 'b', path: 'c' }, 'tok')).toBeNull()
  })
  it('surfaces a sha conflict from a concurrent write', async () => {
    installFetch()
    remote = { text: JSON.stringify(await buildBackup(await seeded(1), '2026-09-18T10:00:00')), sha: 'current' }
    await expect(putFile({ owner: 'a', repo: 'b', path: 'c' }, 'tok', '{}', 'stale', 'm')).rejects.toSatisfy(
      (e: unknown) => e instanceof GitHubError && e.status === 409,
    )
  })
})

describe('loadConfig', () => {
  it('is null until both repo and token exist', async () => {
    const db = await seeded(0)
    expect(await loadConfig(db)).toBeNull()
    await setSetting(db, SYNC_KEYS.repo, 'felipe/gastos-dados')
    expect(await loadConfig(db)).toBeNull()
    await setSetting(db, SYNC_KEYS.token, 'tok')
    expect(await loadConfig(db)).toEqual({ owner: 'felipe', repo: 'gastos-dados', path: DEFAULT_SYNC_PATH, token: 'tok' })
  })
})
