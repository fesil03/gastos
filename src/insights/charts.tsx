import { useState } from 'react'
import { formatMinor } from '../lib/money'

// Hand-rolled SVG/HTML charts. No chart library: keeps the bundle small and offline.
// Mark specs: bars ≤ 24px, 4px rounded data-end, 2px surface gaps, hairline grid,
// legend always present for ≥ 2 series, tooltips on tap (touch-first).

export const SURFACE = '#020617'
export const INK = { primary: '#f1f5f9', secondary: '#94a3b8', muted: '#64748b' }

export function compact(minor: number, currency: string): string {
  const abs = Math.abs(minor)
  const sym = currency === 'CNY' ? '¥' : currency === 'BRL' ? 'R$' : currency === 'USD' ? '$' : ''
  // minor units: ¥1k = 100_000, ¥1M = 100_000_000
  if (abs >= 100_000_000) return `${sym}${(abs / 100_000_000).toFixed(1).replace('.', ',')}M`
  if (abs >= 1_000_000) return `${sym}${Math.round(abs / 100_000)}k`
  if (abs >= 100_000) return `${sym}${(abs / 100_000).toFixed(1).replace('.', ',')}k`
  return formatMinor(abs, currency, { sign: false }).replace(/,00$/, '')
}

// ---------- Donut ----------

export interface DonutSlice {
  id: number
  label: string
  color: string
  valueMinor: number
  share: number
}

export function Donut({ slices, currency, totalLabel }: { slices: DonutSlice[]; currency: string; totalLabel: string }) {
  const [active, setActive] = useState<number | null>(null)
  const total = slices.reduce((s, x) => s + x.valueMinor, 0)
  const R = 54
  const r = 38
  const C = 64
  let angle = -Math.PI / 2
  const paths = slices.map((s) => {
    const frac = total ? s.valueMinor / total : 0
    const a0 = angle
    const a1 = angle + frac * Math.PI * 2
    angle = a1
    return { s, d: arcPath(C, C, R, r, a0, a1), frac }
  })
  const shown = active != null ? slices.find((s) => s.id === active) : null

  return (
    <div className="flex items-center gap-4" data-testid="donut">
      <svg width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="Distribuição por grupo">
        {paths.map(({ s, d }) => (
          <path
            key={s.id}
            d={d}
            fill={s.color}
            opacity={active == null || active === s.id ? 1 : 0.35}
            stroke={SURFACE}
            strokeWidth={2}
            onPointerDown={() => setActive((a) => (a === s.id ? null : s.id))}
            style={{ cursor: 'pointer' }}
          />
        ))}
        <text x={C} y={C - 4} textAnchor="middle" fill={INK.primary} fontSize="13" fontWeight="600">
          {shown ? compact(shown.valueMinor, currency) : compact(total, currency)}
        </text>
        <text x={C} y={C + 12} textAnchor="middle" fill={INK.secondary} fontSize="9">
          {shown ? `${Math.round(shown.share * 100)}%` : totalLabel}
        </text>
      </svg>
      <ul className="min-w-0 flex-1 space-y-1 text-xs" aria-label="Legenda">
        {slices.map((s) => (
          <li
            key={s.id}
            className={`flex items-center gap-2 ${active != null && active !== s.id ? 'opacity-40' : ''}`}
            onPointerDown={() => setActive((a) => (a === s.id ? null : s.id))}
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} />
            <span className="min-w-0 flex-1 truncate text-slate-300">{s.label}</span>
            <span className="tabular-nums text-slate-500">{Math.round(s.share * 100)}%</span>
            <span className="w-16 text-right tabular-nums text-slate-200">{compact(s.valueMinor, currency)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function arcPath(cx: number, cy: number, R: number, r: number, a0: number, a1: number): string {
  if (a1 - a0 >= Math.PI * 2 - 1e-6) {
    // full circle: two arcs
    return `M${cx + R},${cy} A${R},${R} 0 1 1 ${cx - R},${cy} A${R},${R} 0 1 1 ${cx + R},${cy} M${cx + r},${cy} A${r},${r} 0 1 0 ${cx - r},${cy} A${r},${r} 0 1 0 ${cx + r},${cy} Z`
  }
  const large = a1 - a0 > Math.PI ? 1 : 0
  const p = (rad: number, a: number) => `${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`
  return `M${p(R, a0)} A${R},${R} 0 ${large} 1 ${p(R, a1)} L${p(r, a1)} A${r},${r} 0 ${large} 0 ${p(r, a0)} Z`
}

// ---------- Monthly columns ----------

export interface MonthPoint {
  month: string
  label: string
  valueMinor: number
  count: number
  incomplete: boolean
  /** Declared untracked (spec §8): drawn as a gap, never as a zero, never in the mean. */
  untracked?: boolean
}

export function MonthlyColumns({ points, currency, color = '#d95926' }: { points: MonthPoint[]; currency: string; color?: string }) {
  const [active, setActive] = useState<number | null>(null)
  const W = 340
  const H = 150
  const padL = 34
  const padB = 18
  const padT = 8
  const innerW = W - padL - 6
  const innerH = H - padB - padT
  const max = Math.max(1, ...points.map((p) => p.valueMinor))
  const nice = niceMax(max)
  const slot = innerW / Math.max(points.length, 1)
  const barW = Math.min(24, slot - 2)
  const y = (v: number) => padT + innerH - (v / nice) * innerH
  const ticks = [0, nice / 2, nice]

  // Trend: mean of complete, tracked months, drawn as a hairline reference.
  const complete = points.filter((p) => !p.incomplete && !p.untracked)
  const mean = complete.length ? Math.round(complete.reduce((s, p) => s + p.valueMinor, 0) / complete.length) : null
  const a = active != null ? points[active] : null

  return (
    <div data-testid="monthly-columns">
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Total mensal">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - 6} y1={y(t)} y2={y(t)} stroke="#1e293b" strokeWidth={1} />
            <text x={padL - 4} y={y(t) + 3} textAnchor="end" fill={INK.muted} fontSize="8">
              {compact(t, currency)}
            </text>
          </g>
        ))}
        {mean != null && <line x1={padL} x2={W - 6} y1={y(mean)} y2={y(mean)} stroke={INK.secondary} strokeWidth={1} strokeDasharray="0" opacity={0.5} />}
        {points.map((p, i) => {
          const x = padL + i * slot + (slot - barW) / 2
          const h = Math.max(0, padT + innerH - y(p.valueMinor))
          const isActive = active === i
          return (
            <g key={p.month} onPointerDown={() => setActive((v) => (v === i ? null : i))} style={{ cursor: 'pointer' }}>
              <rect x={padL + i * slot} y={padT} width={slot} height={innerH} fill="transparent" />
              {p.untracked ? (
                // Gap marker: a faint dotted column with no height — "nothing was measured here".
                <line x1={x + barW / 2} x2={x + barW / 2} y1={padT + 4} y2={padT + innerH} stroke={INK.muted} strokeWidth={1} strokeDasharray="2 4" opacity={0.6} />
              ) : p.incomplete ? (
                <rect x={x} y={y(p.valueMinor)} width={barW} height={h} fill="none" stroke={color} strokeWidth={1} strokeDasharray="3 2" opacity={0.7} rx={2} />
              ) : (
                <path d={roundedTop(x, y(p.valueMinor), barW, h, 4)} fill={color} opacity={active == null || isActive ? 1 : 0.5} />
              )}
              {(points.length <= 13 || (points.length <= 24 ? i % 3 === 0 : i % 6 === 0)) && (
                <text x={x + barW / 2} y={H - 5} textAnchor="middle" fill={isActive ? INK.primary : INK.muted} fontSize="8">
                  {p.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <p className="mt-1 h-5 text-xs text-slate-400" data-testid="monthly-tooltip">
        {a ? (
          <>
            <span className="text-slate-200">{a.label}</span>
            {a.untracked ? (
              <span className="text-slate-500"> · sem registro (declarado)</span>
            ) : (
              <>
                {' '}
                · {formatMinor(a.valueMinor, currency, { sign: false })} · {a.count} lanç.
                {a.incomplete && <span className="text-amber-400"> · incompleto</span>}
              </>
            )}
          </>
        ) : mean != null ? (
          <>
            média dos meses completos: <span className="text-slate-200">{formatMinor(mean, currency, { sign: false })}</span>
            {points.some((p) => p.incomplete) && <span className="text-slate-500"> · tracejado = incompleto</span>}
            {points.some((p) => p.untracked) && <span className="text-slate-500"> · pontilhado = sem registro</span>}
          </>
        ) : (
          ' '
        )}
      </p>
    </div>
  )
}

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h, w / 2)
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`
}

function niceMax(v: number): number {
  if (v <= 0) return 1
  const exp = Math.pow(10, Math.floor(Math.log10(v)))
  const m = v / exp
  const nice = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10
  return nice * exp
}

// ---------- Ranked bars ----------

export interface RankedRow {
  id: number
  label: string
  color: string
  valueMinor: number
  share: number
  count: number
}

export function RankedBars({ rows, currency, limit = 8 }: { rows: RankedRow[]; currency: string; limit?: number }) {
  const [showAll, setShowAll] = useState(false)
  const max = Math.max(1, ...rows.map((r) => r.valueMinor))
  const visible = showAll ? rows : rows.slice(0, limit)
  return (
    <div data-testid="ranked-bars">
      <ul className="space-y-1.5">
        {visible.map((r) => (
          <li key={r.id} className="text-xs">
            <div className="mb-0.5 flex items-baseline justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: r.color }} />
                <span className="truncate text-slate-300">{r.label}</span>
                <span className="text-slate-600">· {r.count}</span>
              </span>
              <span className="shrink-0 tabular-nums text-slate-200">
                {formatMinor(r.valueMinor, currency, { sign: false })} <span className="text-slate-500">{Math.round(r.share * 100)}%</span>
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-900">
              <div className="h-full rounded-r-full" style={{ width: `${(r.valueMinor / max) * 100}%`, background: r.color }} />
            </div>
          </li>
        ))}
      </ul>
      {rows.length > limit && (
        <button className="mt-2 text-xs text-slate-500 underline-offset-2 hover:underline" onClick={() => setShowAll((s) => !s)}>
          {showAll ? 'menos' : `mais ${rows.length - limit}…`}
        </button>
      )}
    </div>
  )
}

// ---------- Heatmap ----------

const WEEKDAYS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom']

export function Heatmap({ count, totalMinor, currency, mode }: { count: number[][]; totalMinor: number[][]; currency: string; mode: 'count' | 'total' }) {
  const [active, setActive] = useState<[number, number] | null>(null)
  const grid = mode === 'count' ? count : totalMinor
  const max = Math.max(1, ...grid.flat())
  const cell = 12
  const gap = 2
  const padL = 26
  const padT = 12
  const W = padL + 24 * (cell + gap)
  const H = padT + 7 * (cell + gap)
  const a = active ? { w: active[0], h: active[1], c: count[active[0]][active[1]], t: totalMinor[active[0]][active[1]] } : null
  return (
    <div data-testid="heatmap">
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Hora × dia da semana">
        {[0, 6, 12, 18, 23].map((h) => (
          <text key={h} x={padL + h * (cell + gap) + cell / 2} y={8} textAnchor="middle" fill={INK.muted} fontSize="7">
            {String(h).padStart(2, '0')}
          </text>
        ))}
        {WEEKDAYS.map((d, w) => (
          <text key={d} x={padL - 4} y={padT + w * (cell + gap) + cell - 3} textAnchor="end" fill={INK.muted} fontSize="7">
            {d}
          </text>
        ))}
        {grid.map((row, w) =>
          row.map((v, h) => {
            const t = v / max
            const isA = active?.[0] === w && active?.[1] === h
            return (
              <rect
                key={`${w}-${h}`}
                x={padL + h * (cell + gap)}
                y={padT + w * (cell + gap)}
                width={cell}
                height={cell}
                rx={2}
                fill={v === 0 ? '#0f172a' : seq(t)}
                stroke={isA ? INK.primary : 'none'}
                strokeWidth={isA ? 1 : 0}
                onPointerDown={() => setActive((cur) => (cur && cur[0] === w && cur[1] === h ? null : [w, h]))}
              />
            )
          }),
        )}
      </svg>
      <p className="mt-1 h-5 text-xs text-slate-400" data-testid="heatmap-tooltip">
        {a ? (
          <>
            <span className="text-slate-200">
              {WEEKDAYS[a.w]} {String(a.h).padStart(2, '0')}h
            </span>{' '}
            · {a.c} lanç. · {formatMinor(a.t, currency, { sign: false })}
          </>
        ) : (
          <span className="text-slate-500">toque numa célula · escuro = mais {mode === 'count' ? 'lançamentos' : 'gasto'}</span>
        )}
      </p>
    </div>
  )
}

/** Sequential single-hue ramp (orange), light → dark on the dark surface = dim → bright. */
function seq(t: number): string {
  // interpolate between a dim step and the full hue in sRGB (fine for 5 visual steps)
  const a = [120, 52, 20] // dim orange-brown
  const b = [255, 140, 70] // bright orange
  const k = 0.25 + 0.75 * Math.sqrt(t)
  const c = a.map((x, i) => Math.round(x + (b[i] - x) * k))
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

// ---------- Stat tile ----------

export function StatTile({ label, value, sub, testId, className = '' }: { label: string; value: string; sub?: string; testId?: string; className?: string }) {
  return (
    <div className={`rounded-2xl bg-slate-900/60 p-3 ${className}`} data-testid={testId}>
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums leading-tight">{value}</p>
      {sub && <p className="text-[11px] text-slate-500">{sub}</p>}
    </div>
  )
}
