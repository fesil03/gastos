import { usePwa } from '../settings/SettingsScreen'
import { applyUpdate } from '../pwa'

/** Slim banner when a new service worker is waiting. */
export function UpdateBanner() {
  const pwa = usePwa()
  if (!pwa.needRefresh) return null
  return (
    <div className="fixed inset-x-0 top-0 z-40 flex justify-center px-4 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
      <button onClick={() => void applyUpdate()} data-testid="update-banner" className="rounded-full bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 shadow-lg">
        Nova versão — toque para atualizar
      </button>
    </div>
  )
}
