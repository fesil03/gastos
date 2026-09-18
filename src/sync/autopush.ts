import type { GastosDB } from '../db/db'
import { getSetting } from '../db/db'
import { loadConfig, pushSnapshot, SYNC_KEYS } from './snapshot'

/**
 * Keeps the repo snapshot fresh without the user thinking about it.
 *
 * Writes are cheap and non-destructive (phone → repo), so they happen automatically; reads are
 * destructive (repo → device replaces everything) and stay manual. Pulling and importing suspend
 * the watcher, so restoring a snapshot does not immediately push it straight back.
 */

type Listener = () => void
const listeners = new Set<Listener>()
let suspended = 0

export const autoPushState = {
  status: 'idle' as 'idle' | 'pending' | 'pushing' | 'ok' | 'error' | 'offline',
  lastError: null as string | null,
  lastPushAt: null as string | null,
}

function notify() {
  listeners.forEach((l) => l())
}

export function subscribeAutoPush(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Runs `fn` with change-tracking off — used by pull and by CSV import. */
export async function withSyncSuspended<T>(fn: () => Promise<T>): Promise<T> {
  suspended++
  try {
    return await fn()
  } finally {
    suspended--
  }
}

let dirty = false
let timer: ReturnType<typeof setTimeout> | null = null
let inFlight = false
const DEBOUNCE_MS = 20_000

function markDirty(db: GastosDB) {
  if (suspended > 0) return
  dirty = true
  if (autoPushState.status !== 'pushing') {
    autoPushState.status = 'pending'
    notify()
  }
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void flush(db), DEBOUNCE_MS)
}

/** Pushes now if there is anything to push. Safe to call at any time. */
export async function flush(db: GastosDB, opts: { force?: boolean } = {}): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (inFlight || (!dirty && !opts.force)) return
  if (!(await getSetting<boolean>(db, SYNC_KEYS.auto, true))) return
  const cfg = await loadConfig(db)
  if (!cfg) return
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    autoPushState.status = 'offline'
    notify()
    return
  }

  inFlight = true
  autoPushState.status = 'pushing'
  notify()
  try {
    const r = await pushSnapshot(db, cfg, { device: deviceLabel() })
    if (r.status === 'pushed') {
      dirty = false
      autoPushState.status = 'ok'
      autoPushState.lastError = null
      autoPushState.lastPushAt = r.local.exportedAt
    } else {
      // The guard refused: this device has less data than the repo. Never force automatically.
      autoPushState.status = 'error'
      autoPushState.lastError = r.reason ?? 'envio bloqueado'
    }
  } catch (e) {
    autoPushState.status = 'error'
    autoPushState.lastError = e instanceof Error ? e.message : String(e)
  } finally {
    inFlight = false
    notify()
  }
}

export function deviceLabel(): string {
  if (typeof navigator === 'undefined') return 'desconhecido'
  const ua = navigator.userAgent
  if (/Android/i.test(ua)) return 'Android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone'
  if (/Macintosh/i.test(ua)) return 'Mac'
  if (/Windows/i.test(ua)) return 'Windows'
  return 'navegador'
}

/** Registers Dexie hooks so any local write schedules a push. Call once at startup. */
export function watchForChanges(db: GastosDB): void {
  const bump = () => markDirty(db)
  const tables = [db.transactions, db.categories, db.tags, db.untrackedPeriods, db.balanceChecks]
  for (const t of tables) {
    t.hook('creating', bump)
    t.hook('updating', bump)
    t.hook('deleting', bump)
  }
  if (typeof window !== 'undefined') {
    // A push that failed while offline gets another chance as soon as the network is back.
    window.addEventListener('online', () => {
      if (dirty) void flush(db)
    })
    // Leaving the app is the last chance to persist a pending change.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && dirty) void flush(db)
    })
  }
}
