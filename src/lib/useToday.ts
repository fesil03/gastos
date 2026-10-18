import { useEffect, useState } from 'react'
import { dayKey, msUntilNextDay } from './dates'

/**
 * Today's 'YYYY-MM-DD', kept current. A plain dayKey() at render goes stale when the app stays
 * open across midnight, or is resumed from the background the next day — the PWA on the phone
 * is usually suspended rather than reloaded. Re-checks at midnight and whenever the app comes
 * back to the foreground; setting the same string again does not re-render.
 */
export function useToday(): string {
  const [today, setToday] = useState(() => dayKey())
  useEffect(() => {
    const sync = () => setToday(dayKey())
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      timer = setTimeout(() => {
        sync()
        schedule()
      }, msUntilNextDay())
    }
    schedule()
    const onVisible = () => {
      if (document.visibilityState === 'visible') sync()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', sync)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', sync)
    }
  }, [])
  return today
}
