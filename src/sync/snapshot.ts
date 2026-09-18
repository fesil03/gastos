import type { GastosDB } from '../db/db'
import { getSetting, setSetting } from '../db/db'
import { buildBackup, parseBackup, restoreBackup, type Backup } from '../export/backup'
import { nowIso } from '../lib/dates'
import { getFile, putFile, type RepoRef } from './github'

/**
 * One-directional snapshot sync (see README "Sincronização").
 *
 * The phone is where entries are made, so it is the only writer: it pushes a full JSON snapshot
 * to a private repo, and any other device pulls that snapshot and replaces its local data with it.
 * There is no merge and no conflict resolution, because with a single writer there is nothing to
 * merge — which is also why this needs no global ids, no updatedAt and no tombstones.
 *
 * The cost of that simplicity, stated plainly: a change made on a device that only pulls is lost
 * at the next pull. The push guard below is what keeps that from happening silently in reverse.
 */

export const SYNC_KEYS = {
  repo: 'sync:repo',
  path: 'sync:path',
  token: 'sync:token',
  auto: 'sync:auto',
  lastPush: 'sync:lastPush',
  lastPull: 'sync:lastPull',
  sha: 'sync:sha',
} as const

export const DEFAULT_SYNC_PATH = 'gastos-backup.json'

export interface SyncConfig {
  owner: string
  repo: string
  path: string
  token: string
}

export function refOf(cfg: SyncConfig): RepoRef {
  return { owner: cfg.owner, repo: cfg.repo, path: cfg.path }
}

export interface SnapshotMeta {
  exportedAt: string
  transactions: number
  categories: number
  device?: string
}

/** Reads the counts out of a snapshot without trusting it to be well-formed. */
export function metaOf(b: Backup): SnapshotMeta {
  return {
    exportedAt: b.exportedAt,
    transactions: b.transactions.length,
    categories: b.categories.length,
    device: (b as Backup & { device?: string }).device,
  }
}

export interface PushResult {
  status: 'pushed' | 'blocked'
  local: SnapshotMeta
  remote?: SnapshotMeta
  /** Set when status is 'blocked': why the guard stopped the push. */
  reason?: string
}

/**
 * Pushes the local database as the snapshot.
 *
 * Guard: if the snapshot already in the repo holds more transactions than this device does, the
 * push is refused unless `force` is passed. That is the accident this design is most exposed to —
 * pressing send on the laptop, whose copy is older, and overwriting the phone's real data with it.
 */
export async function pushSnapshot(
  db: GastosDB,
  cfg: SyncConfig,
  opts: { force?: boolean; device?: string; signal?: AbortSignal } = {},
): Promise<PushResult> {
  const backup = await buildBackup(db, nowIso())
  const payload: Backup & { device?: string } = { ...backup }
  if (opts.device) payload.device = opts.device
  const local = metaOf(payload)

  const existing = await getFile(refOf(cfg), cfg.token, opts.signal)
  let remote: SnapshotMeta | undefined
  if (existing) {
    try {
      remote = metaOf(parseBackup(existing.text))
    } catch {
      remote = undefined // unreadable remote: treat as absent, the push replaces it
    }
  }

  if (!opts.force && remote && remote.transactions > local.transactions) {
    return {
      status: 'blocked',
      local,
      remote,
      reason: `O snapshot no repositório tem ${remote.transactions} lançamentos e este aparelho tem ${local.transactions}.`,
    }
  }

  const message = `gastos: ${local.transactions} lançamentos · ${local.exportedAt.replace('T', ' ')}${opts.device ? ` · ${opts.device}` : ''}`
  const { sha } = await putFile(refOf(cfg), cfg.token, JSON.stringify(payload), existing?.sha, message, opts.signal)
  await setSetting(db, SYNC_KEYS.sha, sha)
  await setSetting(db, SYNC_KEYS.lastPush, { at: local.exportedAt, transactions: local.transactions })
  return { status: 'pushed', local, remote }
}

export interface PullResult {
  status: 'pulled' | 'empty'
  remote?: SnapshotMeta
  transactions?: number
}

/** Replaces everything on this device with the repo's snapshot. Destructive by design. */
export async function pullSnapshot(db: GastosDB, cfg: SyncConfig, opts: { signal?: AbortSignal } = {}): Promise<PullResult> {
  const file = await getFile(refOf(cfg), cfg.token, opts.signal)
  if (!file) return { status: 'empty' }
  const backup = parseBackup(file.text)
  const remote = metaOf(backup)
  await restoreBackup(db, backup, 'replace')
  await setSetting(db, SYNC_KEYS.sha, file.sha)
  await setSetting(db, SYNC_KEYS.lastPull, { at: nowIso(), transactions: remote.transactions, exportedAt: remote.exportedAt })
  return { status: 'pulled', remote, transactions: remote.transactions }
}

/** Reads the stored configuration, or null when sync has not been set up on this device. */
export async function loadConfig(db: GastosDB): Promise<SyncConfig | null> {
  const repo = await getSetting<string>(db, SYNC_KEYS.repo, '')
  const token = await getSetting<string>(db, SYNC_KEYS.token, '')
  const path = await getSetting<string>(db, SYNC_KEYS.path, DEFAULT_SYNC_PATH)
  if (!repo || !token) return null
  const [owner, name] = repo.split('/')
  if (!owner || !name) return null
  return { owner, repo: name, path: path || DEFAULT_SYNC_PATH, token }
}
