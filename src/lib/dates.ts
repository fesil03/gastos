// Dates are local naive ISO strings: 'YYYY-MM-DDTHH:mm:ss'. Never UTC, never toISOString().

const p = (n: number) => String(n).padStart(2, '0')

export function toLocalIso(d: Date): string {
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function nowIso(): string {
  return toLocalIso(new Date())
}

/** 'YYYY-MM-DD' for today, or shifted by `offsetDays`. */
export function dayKey(d = new Date(), offsetDays = 0): string {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays)
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`
}

/** Parse a naive ISO string into a local Date (for arithmetic and weekday/hour only). */
export function fromLocalIso(iso: string): Date {
  const [date, time = '00:00:00'] = iso.split('T')
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm, ss] = time.split(':').map(Number)
  return new Date(y, m - 1, d, hh || 0, mm || 0, ss || 0)
}

export function monthKey(iso: string): string {
  return iso.slice(0, 7)
}

export function dateOf(iso: string): string {
  return iso.slice(0, 10)
}

export function hourOf(iso: string): number {
  return Number(iso.slice(11, 13))
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayOf(iso: string): number {
  const d = fromLocalIso(iso).getDay()
  return (d + 6) % 7
}

/** Inclusive day range → ISO bounds usable with Dexie .between(lo, hi, true, true). */
export function dayBounds(fromDay: string, toDay: string): [string, string] {
  return [`${fromDay}T00:00:00`, `${toDay}T23:59:59`]
}

export function addMonths(monthKeyStr: string, n: number): string {
  const [y, m] = monthKeyStr.split('-').map(Number)
  const d = new Date(y, m - 1 + n, 1)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}`
}

/** ['YYYY-MM-01', 'YYYY-MM-<last>'] for a month key. */
export function monthBounds(monthKeyStr: string): [string, string] {
  const [y, m] = monthKeyStr.split('-').map(Number)
  const last = new Date(y, m, 0).getDate()
  return [`${monthKeyStr}-01`, `${monthKeyStr}-${p(last)}`]
}

export function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((fromLocalIso(toDay).getTime() - fromLocalIso(fromDay).getTime()) / 86_400_000)
}

const MONTHS_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
const WEEKDAYS_PT = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom']

export function formatMonth(monthKeyStr: string): string {
  const [y, m] = monthKeyStr.split('-')
  return `${MONTHS_PT[Number(m) - 1]} ${y.slice(2)}`
}

export function formatDay(day: string, today = dayKey()): string {
  if (day === today) return 'Hoje'
  if (day === dayKey(fromLocalIso(today), -1)) return 'Ontem'
  const d = fromLocalIso(day)
  const wd = WEEKDAYS_PT[(d.getDay() + 6) % 7]
  const label = `${wd}, ${d.getDate()} ${MONTHS_PT[d.getMonth()]}`
  return day.slice(0, 4) === today.slice(0, 4) ? label : `${label} ${day.slice(0, 4)}`
}

/** '2025-01-05' → '5 jan 2025' (always with the year). */
export function formatDayFull(day: string): string {
  const [y, m, d] = day.split('-')
  return `${Number(d)} ${MONTHS_PT[Number(m) - 1]} ${y}`
}

export function formatTime(iso: string): string {
  return iso.slice(11, 16)
}

export { WEEKDAYS_PT, MONTHS_PT }
