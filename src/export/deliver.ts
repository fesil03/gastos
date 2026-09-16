// Getting a file out of a PWA on a phone: Web Share (files) → download link → clipboard.

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Fallback for older WebViews
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}

export function canShareFiles(): boolean {
  try {
    const f = new File(['x'], 'x.txt', { type: 'text/plain' })
    return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [f] })
  } catch {
    return false
  }
}

export async function shareOrDownload(filename: string, text: string, mime: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const file = new File([text], filename, { type: mime })
  if (canShareFiles()) {
    try {
      await navigator.share({ files: [file], title: filename })
      return 'shared'
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled'
      // fall through to download
    }
  }
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return 'downloaded'
}
