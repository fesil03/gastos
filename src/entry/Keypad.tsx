import { useEffect } from 'react'

interface Props {
  value: string
  onChange: (next: string) => void
  onSubmit?: () => void
  disabled?: boolean
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'] as const

export function applyKey(value: string, key: string): string {
  if (key === '⌫') return value.slice(0, -1)
  if (key === '.') return value.includes('.') ? value : value === '' ? '0.' : value + '.'
  if (!/^\d$/.test(key)) return value
  const [whole, frac] = value.split('.')
  if (frac !== undefined) return frac.length >= 2 ? value : value + key
  if (whole === '0') return key // no leading zeros
  if (whole.length >= 7) return value // ¥9,999,999 is plenty
  return value + key
}

export function Keypad({ value, onChange, onSubmit, disabled }: Props) {
  // Hardware keyboard support for desktop use / tests.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (disabled) return
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT' || (e.target as HTMLElement | null)?.tagName === 'TEXTAREA') return
      if (/^\d$/.test(e.key) || e.key === '.' || e.key === ',') onChange(applyKey(value, e.key === ',' ? '.' : e.key))
      else if (e.key === 'Backspace') onChange(applyKey(value, '⌫'))
      else if (e.key === 'Enter') onSubmit?.()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [value, onChange, onSubmit, disabled])

  return (
    <div className="grid grid-cols-3 gap-2" data-testid="keypad">
      {KEYS.map((k) => (
        <button
          key={k}
          type="button"
          data-key={k}
          disabled={disabled}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => onChange(applyKey(value, k))}
          className={`h-14 select-none rounded-2xl text-2xl font-medium tabular-nums transition active:scale-95 ${
            k === '⌫' ? 'bg-slate-800 text-slate-300' : 'bg-slate-900 text-slate-100'
          } disabled:opacity-40`}
        >
          {k}
        </button>
      ))}
    </div>
  )
}
