import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { isNative } from './native'
import type { Song } from './types'

/* Lyrics from LRCLIB (lrclib.net: free, no key, line-synced when available),
   cached on the phone so they also work offline. */

export interface LyricLine {
  t: number // seconds
  text: string
}

export interface Lyrics {
  synced?: LyricLine[]
  plain?: string
  instrumental?: boolean
  found: boolean
  at: number // when it was looked up
}

interface LrcRecord {
  artistName: string
  trackName: string
  duration: number
  instrumental: boolean
  plainLyrics: string | null
  syncedLyrics: string | null
}

const API = 'https://lrclib.net/api'

/** "Artista – Titolo (Official Video)" -> { artist, track } */
export function splitTitle(title: string): { artist: string; track: string } {
  const clean = (t: string) =>
    t
      .replace(/\(.*?\)|\[.*?]/g, ' ')
      .replace(/\b(official|video|audio|lyrics?|testo|remaster(ed)?|hd|4k)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  const m = title.match(/^(.+?)\s+[–-]\s+(.+)$/)
  return m ? { artist: clean(m[1]), track: clean(m[2]) } : { artist: '', track: clean(title) }
}

export function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = []
  for (const line of lrc.split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)]/g)]
    if (!stamps.length) continue
    const text = line.replace(/\[[^\]]*]/g, '').trim()
    for (const s of stamps) out.push({ t: Number(s[1]) * 60 + Number(s[2]), text })
  }
  return out.sort((a, b) => a.t - b.t)
}

async function getJson<T>(url: string): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url).catch(() => null)
    if (!res) return null
    if (res.status === 404) return null
    if (res.status === 503 || res.status === 429) {
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
      continue
    }
    if (!res.ok) return null
    return (await res.json()) as T
  }
  return null
}

async function lookup(song: Song): Promise<LrcRecord | null> {
  const { artist, track } = splitTitle(song.title)
  const dur = Math.round(song.duration || 0)
  if (artist && track) {
    const exact = await getJson<LrcRecord>(
      `${API}/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(track)}${dur ? `&duration=${dur}` : ''}`
    )
    if (exact && (exact.syncedLyrics || exact.plainLyrics || exact.instrumental)) return exact
  }
  const q = artist ? `track_name=${encodeURIComponent(track)}&artist_name=${encodeURIComponent(artist)}` : `q=${encodeURIComponent(track)}`
  const list = (await getJson<LrcRecord[]>(`${API}/search?${q}`)) ?? []
  // closest duration, synced preferred
  const scored = list
    .filter((r) => r.syncedLyrics || r.plainLyrics)
    .map((r) => ({ r, d: dur ? Math.abs(r.duration - dur) : 0 }))
    .filter((x) => !dur || x.d <= 15)
    .sort((a, b) => a.d + (a.r.syncedLyrics ? 0 : 5) - (b.d + (b.r.syncedLyrics ? 0 : 5)))
  return scored[0]?.r ?? null
}

const file = (id: string) => `lyrics/${id}.json`

async function readCache(id: string): Promise<Lyrics | null> {
  try {
    if (isNative) {
      const r = await Filesystem.readFile({ path: file(id), directory: Directory.Data, encoding: Encoding.UTF8 })
      return JSON.parse(r.data as string) as Lyrics
    }
    const raw = localStorage.getItem(`stemkit:${file(id)}`)
    return raw ? (JSON.parse(raw) as Lyrics) : null
  } catch {
    return null
  }
}

async function writeCache(id: string, l: Lyrics): Promise<void> {
  const data = JSON.stringify(l)
  try {
    if (isNative) await Filesystem.writeFile({ path: file(id), data, directory: Directory.Data, encoding: Encoding.UTF8, recursive: true })
    else localStorage.setItem(`stemkit:${file(id)}`, data)
  } catch {
    /* cache is best effort */
  }
}

/** Cached lyrics, or a fresh lookup (a "not found" is retried after a week). */
export async function getLyrics(song: Song, force = false): Promise<Lyrics> {
  const cached = force ? null : await readCache(song.id)
  if (cached && (cached.found || Date.now() - cached.at < 7 * 86400_000)) return cached
  const rec = await lookup(song)
  const l: Lyrics = rec
    ? {
        found: true,
        at: Date.now(),
        instrumental: rec.instrumental,
        synced: rec.syncedLyrics ? parseLrc(rec.syncedLyrics) : undefined,
        plain: rec.plainLyrics ?? undefined
      }
    : { found: false, at: Date.now() }
  await writeCache(song.id, l)
  return l
}

export async function deleteLyrics(id: string): Promise<void> {
  try {
    if (isNative) await Filesystem.deleteFile({ path: file(id), directory: Directory.Data })
    else localStorage.removeItem(`stemkit:${file(id)}`)
  } catch {
    /* none */
  }
}
