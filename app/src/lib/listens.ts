import { artistOf } from './media'

/* What you listened to lately (any song, also the ones only streamed from
   Cerca): one line per play, kept 30 days. "Cerca" builds its suggestions
   mostly from the last week of it. */

interface Listen {
  at: number
  title: string
}

const KEY = 'stemkit:listens'
const KEEP = 30 * 86400_000

function load(): Listen[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Listen[]
  } catch {
    return []
  }
}

export function logListen(title: string) {
  const now = Date.now()
  const all = load().filter((l) => now - l.at < KEEP)
  const last = all[all.length - 1]
  // the same song shown again (engine handing it back, a restart): one play
  if (last && last.title === title && now - last.at < 90_000) return
  all.push({ at: now, title })
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* storage full or private mode: suggestions fall back to the library */
  }
}

/** plays per artist in the last `days` (main artist of each song) */
export function recentArtists(days = 7): Map<string, number> {
  const from = Date.now() - days * 86400_000
  const out = new Map<string, number>()
  for (const l of load()) {
    if (l.at < from) continue
    const a = artistOf(l.title).split(/,| feat\.| ft\.| & /i)[0].trim()
    if (a) out.set(a, (out.get(a) ?? 0) + 1)
  }
  return out
}
