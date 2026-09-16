import { useEffect } from 'react'

export interface ToastState {
  id: number
  message: string
  actionLabel?: string
  onAction?: () => void
  ttlMs?: number
}

export function Toast({ toast, onDismiss }: { toast: ToastState | null; onDismiss: (id: number) => void }) {
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => onDismiss(toast.id), toast.ttlMs ?? 5000)
    return () => clearTimeout(t)
  }, [toast, onDismiss])

  if (!toast) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-40 flex justify-center px-4">
      <div
        role="status"
        data-testid="toast"
        className="pointer-events-auto flex max-w-md items-center gap-3 rounded-full bg-slate-100 px-4 py-2.5 text-sm text-slate-900 shadow-lg"
      >
        <span className="truncate">{toast.message}</span>
        {toast.actionLabel && (
          <button
            data-testid="toast-action"
            className="shrink-0 font-semibold text-amber-700"
            onClick={() => {
              toast.onAction?.()
              onDismiss(toast.id)
            }}
          >
            {toast.actionLabel}
          </button>
        )}
      </div>
    </div>
  )
}
