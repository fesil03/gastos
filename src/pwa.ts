import { registerSW } from 'virtual:pwa-register'

// Phase 6 — PWA plumbing: service-worker updates, install prompt, storage persistence.

type Listener = () => void
const listeners = new Set<Listener>()
const notify = () => listeners.forEach((l) => l())

export const pwaState = {
  needRefresh: false,
  offlineReady: false,
  installPrompt: null as null | (Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }),
  installed: false,
  persisted: null as boolean | null,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
}

let updateSW: ((reload?: boolean) => Promise<void>) | null = null

export function initPwa(): void {
  updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      pwaState.needRefresh = true
      notify()
    },
    onOfflineReady() {
      pwaState.offlineReady = true
      notify()
    },
  })

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    pwaState.installPrompt = e as typeof pwaState.installPrompt
    notify()
  })
  window.addEventListener('appinstalled', () => {
    pwaState.installed = true
    pwaState.installPrompt = null
    notify()
  })
  window.addEventListener('online', () => {
    pwaState.online = true
    notify()
  })
  window.addEventListener('offline', () => {
    pwaState.online = false
    notify()
  })

  pwaState.installed = isStandalone()
  // A controlling service worker means the shell is already cached from a previous visit.
  if (navigator.serviceWorker?.controller) pwaState.offlineReady = true
  navigator.serviceWorker?.ready.then(() => {
    pwaState.offlineReady = true
    notify()
  })

  // Ask the browser not to evict IndexedDB under storage pressure (Safari honours this for installed PWAs).
  if (navigator.storage?.persist) {
    navigator.storage.persisted().then(async (p) => {
      pwaState.persisted = p || (await navigator.storage.persist())
      notify()
    })
  }
}

export function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true
}

export function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

export async function applyUpdate(): Promise<void> {
  await updateSW?.(true)
}

export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const p = pwaState.installPrompt
  if (!p) return 'unavailable'
  await p.prompt()
  const { outcome } = await p.userChoice
  if (outcome === 'accepted') pwaState.installPrompt = null
  notify()
  return outcome
}

export function subscribe(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
