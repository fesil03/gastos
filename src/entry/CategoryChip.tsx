import { useRef } from 'react'
import type { Category, Group } from '../db/types'

interface Props {
  category: Category
  group?: Group
  selected?: boolean
  hint?: string // e.g. last amount, shown small under the name
  onTap: () => void
  onLongPress?: () => void
  size?: 'md' | 'sm'
}

const LONG_PRESS_MS = 450

/** A one-tap category chip. Long-press (≈450 ms) fires onLongPress instead of onTap. */
export function CategoryChip({ category, group, selected, hint, onTap, onLongPress, size = 'md' }: Props) {
  const timer = useRef<number | null>(null)
  const firedLong = useRef(false)

  const start = () => {
    firedLong.current = false
    if (!onLongPress) return
    timer.current = window.setTimeout(() => {
      firedLong.current = true
      timer.current = null
      if (navigator.vibrate) navigator.vibrate(15)
      onLongPress()
    }, LONG_PRESS_MS)
  }
  const cancel = () => {
    if (timer.current != null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }
  const click = () => {
    if (firedLong.current) {
      firedLong.current = false
      return
    }
    onTap()
  }

  const color = group?.color ?? '#94a3b8'
  return (
    <button
      type="button"
      data-testid="chip"
      data-category-id={category.id}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
      onClick={click}
      style={{ borderColor: selected ? color : undefined, boxShadow: `inset 3px 0 0 ${color}` }}
      className={`flex select-none flex-col items-start justify-center overflow-hidden rounded-2xl border-2 pl-2.5 pr-1.5 text-left transition active:scale-95 ${
        size === 'md' ? 'h-16' : 'h-12'
      } ${selected ? 'bg-slate-800' : 'border-transparent bg-slate-900'}`}
    >
      <span className="line-clamp-2 w-full break-normal text-[11px] font-medium leading-[1.15] tracking-tight">{category.name}</span>
      {hint && size === 'md' && <span className="mt-0.5 text-[10.5px] leading-none text-slate-500 tabular-nums">{hint}</span>}
    </button>
  )
}
