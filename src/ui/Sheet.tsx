import { useEffect, type ReactNode } from 'react'

/** Bottom sheet. Closes on backdrop tap or Escape. */
export function Sheet({ title, onClose, children, testId }: { title: string; onClose: () => void; children: ReactNode; testId?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/60" onClick={onClose} data-testid={testId ?? 'sheet'}>
      <div
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-slate-950 px-5 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] pt-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-700" />
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <button className="rounded-full px-3 py-1 text-sm text-slate-400" onClick={onClose} data-testid="sheet-close">
            Fechar
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
