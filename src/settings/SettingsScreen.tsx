import { useEffect, useReducer } from 'react'
import { db, setSetting } from '../db/db'
import { useSetting } from '../db/hooks'
import { DEFAULT_REF_CURRENCY } from '../db/types'
import { applyUpdate, isIos, promptInstall, pwaState, subscribe } from '../pwa'
import { ImportScreen } from '../ui/ImportScreen'
import { SyncCard } from './SyncCard'
import { UntrackedPeriods } from './UntrackedPeriods'

const CURRENCIES = ['CNY', 'BRL', 'USD', 'EUR']

export function usePwa() {
  const [, bump] = useReducer((x: number) => x + 1, 0)
  useEffect(() => subscribe(bump), [])
  return pwaState
}

export function SettingsScreen() {
  const refCurrency = useSetting('refCurrency', DEFAULT_REF_CURRENCY)
  const pwa = usePwa()

  return (
    <div className="space-y-6 pb-8">
      <section className="mx-auto max-w-md space-y-4 px-5 pt-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Ajustes</h1>
        </header>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Moeda de referência</p>
          <div className="flex overflow-hidden rounded-xl bg-slate-800">
            {CURRENCIES.map((c) => (
              <button
                key={c}
                data-testid={`ref-${c}`}
                onClick={() => setSetting(db, 'refCurrency', c)}
                className={`flex-1 py-2 text-xs ${refCurrency === c ? 'bg-slate-600 font-semibold' : 'text-slate-400'}`}
              >
                {c}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-slate-500">Totais e gráficos usam esta moeda. Lançamentos em outra moeda guardam a taxa do dia; mudar aqui não reconverte o histórico.</p>

        </div>

        <SyncCard />

        <UntrackedPeriods />

        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm" data-testid="pwa-card">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">App</p>
          <ul className="space-y-1 text-xs text-slate-400">
            <li>
              Instalado: <span className="text-slate-200" data-testid="pwa-installed">{pwa.installed ? 'sim' : 'não'}</span>
            </li>
            <li>
              Offline: <span className="text-slate-200" data-testid="pwa-offline">{pwa.offlineReady || pwa.installed ? 'pronto' : 'preparando…'}</span>
              {!pwa.online && <span className="text-amber-400"> · sem rede agora</span>}
            </li>
            <li>
              Armazenamento persistente: <span className="text-slate-200" data-testid="pwa-persisted">{pwa.persisted == null ? '—' : pwa.persisted ? 'sim' : 'não'}</span>
            </li>
          </ul>
          {!pwa.installed && pwa.installPrompt && (
            <button data-testid="pwa-install" onClick={() => void promptInstall()} className="mt-3 w-full rounded-xl bg-amber-500 py-2.5 text-sm font-semibold text-slate-950">
              Instalar na tela inicial
            </button>
          )}
          {!pwa.installed && !pwa.installPrompt && isIos() && (
            <p className="mt-3 rounded-xl bg-slate-800/60 p-3 text-xs text-slate-300">
              No iPhone: toque em <span className="font-semibold">Compartilhar</span> no Safari e depois em <span className="font-semibold">Adicionar à Tela de Início</span>. Abra sempre pelo ícone — é isso que mantém os dados e o modo offline.
            </p>
          )}
          {pwa.needRefresh && (
            <button data-testid="pwa-update" onClick={() => void applyUpdate()} className="mt-3 w-full rounded-xl bg-slate-700 py-2.5 text-sm font-medium">
              Nova versão disponível — atualizar
            </button>
          )}
        </div>
      </section>

      <ImportScreen />
    </div>
  )
}
