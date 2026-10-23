import { isNative } from './native'

/* "Aggiornamento disponibile": the newest release on GitHub against the
   version of this app. The phone installs its APK; OpenSpoty for Windows (the
   zip, see bridge/portable.py) has the bridge download and swap the package. */

export const REPO = 'Jacoposchenetti/OpenSpoty'
export const APP_VERSION = __APP_VERSION__

/** OpenSpoty for Windows, the package a friend unpacks (not the dev PC) */
export const isPortable = (window as { __OPENSPOTY_PORTABLE__?: number }).__OPENSPOTY_PORTABLE__ === 1

export interface Update {
  version: string
  url: string // the APK, or the Windows zip
  notes: string
  page: string
}

const newer = (a: string, b: string) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

/** null when up to date (asked to GitHub at most every few hours) */
export async function checkUpdate(force = false): Promise<Update | null> {
  if (!isNative && !isPortable) return null // the dev PC is updated with tools/deploy.sh
  const KEY = isNative ? 'stemkit:update-check' : 'stemkit:update-check-win'
  try {
    const last = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { at: number; found: Update | null } | null
    if (!force && last && Date.now() - last.at < 4 * 3600_000) return last.found && newer(last.found.version, APP_VERSION) ? last.found : null
  } catch {
    /* ignore */
  }
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
  if (!res.ok) return null
  const r = (await res.json()) as { tag_name: string; body?: string; html_url: string; assets: Array<{ name: string; browser_download_url: string }> }
  const apk = r.assets.find((a) => (isNative ? a.name.endsWith('.apk') : a.name === 'OpenSpoty-Windows.zip'))
  const version = r.tag_name.replace(/^v/, '')
  const found = apk ? { version, url: apk.browser_download_url, notes: r.body ?? '', page: r.html_url } : null
  try {
    localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), found }))
  } catch {
    /* ignore */
  }
  return found && newer(found.version, APP_VERSION) ? found : null
}
