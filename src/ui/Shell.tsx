import { useEffect, useState, type ReactNode } from 'react'

export type TabId = 'entry' | 'list' | 'insights' | 'export' | 'settings'

const TABS: { id: TabId; label: string; icon: ReactNode }[] = [
  { id: 'entry', label: 'Lançar', icon: <IconPlus /> },
  { id: 'list', label: 'Lista', icon: <IconList /> },
  { id: 'insights', label: 'Insights', icon: <IconChart /> },
  { id: 'export', label: 'Exportar', icon: <IconShare /> },
  { id: 'settings', label: 'Ajustes', icon: <IconGear /> },
]

export function useTab(): [TabId, (t: TabId) => void] {
  const [tab, setTab] = useState<TabId>(() => {
    const h = location.hash.replace('#', '') as TabId
    return TABS.some((t) => t.id === h) ? h : 'entry'
  })
  useEffect(() => {
    const onHash = () => {
      const h = location.hash.replace('#', '') as TabId
      if (TABS.some((t) => t.id === h)) setTab(h)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return [
    tab,
    (t) => {
      setTab(t)
      history.replaceState(null, '', t === 'entry' ? location.pathname : `#${t}`)
    },
  ]
}

export function Shell({ tab, onTab, children }: { tab: TabId; onTab: (t: TabId) => void; children: ReactNode }) {
  return (
    <div className="mx-auto flex h-full max-w-md flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      <nav
        className="grid shrink-0 grid-cols-5 border-t border-slate-800 bg-slate-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
        data-testid="tabbar"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            data-testid={`tab-${t.id}`}
            onClick={() => onTab(t.id)}
            className={`flex flex-col items-center gap-0.5 py-2 text-[10px] ${tab === t.id ? 'text-amber-400' : 'text-slate-500'}`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  )
}

function IconPlus() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  )
}
function IconList() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
    </svg>
  )
}
function IconChart() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 20V10M10 20V4M16 20v-8M22 20H2" />
    </svg>
  )
}
function IconShare() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12M7 8l5-5 5 5M5 14v5a2 2 0 002 2h10a2 2 0 002-2v-5" />
    </svg>
  )
}
function IconGear() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </svg>
  )
}
