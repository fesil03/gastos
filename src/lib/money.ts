// All money is integer minor units. These helpers only format at render / parse at input.

export function formatMinor(minor: number, currency = 'CNY', opts: { sign?: boolean; symbol?: boolean } = {}): string {
  const { sign = true, symbol = true } = opts
  const neg = minor < 0
  const abs = Math.abs(minor)
  const whole = Math.floor(abs / 100)
  const frac = String(abs % 100).padStart(2, '0')
  const wholeStr = whole.toLocaleString('pt-BR')
  const sym = symbol ? currencySymbol(currency) : ''
  return `${sign && neg ? '-' : ''}${sym}${wholeStr},${frac}`
}

export function currencySymbol(currency: string): string {
  switch (currency) {
    case 'CNY':
      return '¥'
    case 'BRL':
      return 'R$'
    case 'USD':
      return '$'
    case 'EUR':
      return '€'
    default:
      return currency + ' '
  }
}

/** Keypad string ("28.8", "1234", "0.5") → minor units, or null when empty/invalid. String arithmetic only. */
export function keypadToMinor(s: string): number | null {
  const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(s)
  if (!m) return null
  const whole = m[1] || '0'
  const frac = (m[2] ?? '').padEnd(2, '0')
  if (!m[1] && !m[2]) return null
  const minor = Number(whole) * 100 + Number(frac)
  return Number.isSafeInteger(minor) ? minor : null
}

/** Minor units → keypad string (for editing). 2880 → "28.8", 400 → "4", 1250 → "12.5". */
export function minorToKeypad(minor: number): string {
  const abs = Math.abs(minor)
  const whole = Math.floor(abs / 100)
  const frac = abs % 100
  if (frac === 0) return String(whole)
  return `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`
}

/** Display the keypad buffer with a Brazilian decimal comma and thousands dots. */
export function formatKeypad(s: string): string {
  if (!s) return '0'
  const [whole, frac] = s.split('.')
  const w = whole ? Number(whole).toLocaleString('pt-BR') : '0'
  return frac !== undefined ? `${w},${frac}` : w
}

/** amountMinor in currency → refCurrency minor via a stored rate. Rounded half away from zero. */
export function convertMinor(amountMinor: number, fxRate: number): number {
  const v = amountMinor * fxRate
  return v < 0 ? -Math.round(-v) : Math.round(v)
}
