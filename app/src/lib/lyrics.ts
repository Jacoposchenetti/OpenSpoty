import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { engine } from './engine'
import { isLocalPath, originalRef } from './media'
import { isNative } from './native'
import type { Song } from './types'

/* Lyrics from LRCLIB (lrclib.net: free, no key, line-synced when available),
   cached on the phone so they also work offline. Lyrics with only the words
   get their times from the song itself (alignLyrics: Whisper on the vocal
   track, core/LyricsAligner.java), and any line can be moved by hand. */

export interface LyricLine {
  t: number // seconds
  text: string
}

export interface Lyrics {
  synced?: LyricLine[]
  plain?: string
  /** times worked out from the audio, for lyrics that had none */
  aligned?: LyricLine[]
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
    if (exact && (exact.syncedLyrics || exact.instrumental)) return exact
    if (exact?.plainLyrics) {
      // only the words: another upload of the same song may have the times
      const other = ((await getJson<LrcRecord[]>(`${API}/search?track_name=${encodeURIComponent(track)}&artist_name=${encodeURIComponent(artist)}`)) ?? []).find(
        (r) => r.syncedLyrics && (!dur || Math.abs(r.duration - dur) <= 3)
      )
      return other ?? exact
    }
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
  // found with times: for good; found without (or not found): looked up again after a week
  if (cached && (cached.synced || cached.instrumental || Date.now() - cached.at < 7 * 86400_000)) return cached
  if (cached?.found && !cached.synced) {
    const rec = await lookup(song).catch(() => null)
    if (!rec?.syncedLyrics) {
      const kept = { ...cached, at: Date.now() }
      await writeCache(song.id, kept)
      return kept
    }
  }
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

/** the lines that are sung: no empty lines, no "[Ritornello]" headings */
export function plainLines(plain: string): string[] {
  return plain
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^[[(].*[\])]$/.test(l))
}

/** the audio to listen to: the vocal track when the song is split, else the song */
function voiceSource(song: Song): string | null {
  const v = song.files.vocals
  if (song.stems.includes('vocals') && v && isLocalPath(v)) return v
  return originalRef(song) ?? null
}

/** times for lyrics that have only the words: worked out once, then saved with the lyrics */
export async function alignLyrics(song: Song, l: Lyrics, onProgress: (pct: number, downloading: boolean) => void): Promise<Lyrics> {
  if (!l.plain) return l
  const lines = plainLines(l.plain)
  const src = voiceSource(song)
  if (!lines.length || !src) return l
  const times = await engine.alignLyrics(song.id, src, lines, onProgress)
  const next: Lyrics = { ...l, aligned: lines.map((text, i) => ({ t: times[i] ?? 0, text })) }
  await writeCache(song.id, next)
  return next
}

/** a line moved by hand (long press while the song plays): saved with the lyrics */
export async function moveLine(songId: string, l: Lyrics, index: number, t: number): Promise<Lyrics> {
  const key = l.synced ? 'synced' : 'aligned'
  const lines = [...(l[key] ?? [])]
  if (!lines[index]) return l
  lines[index] = { ...lines[index], t: Math.max(0, Math.round(t * 100) / 100) }
  const next: Lyrics = { ...l, [key]: lines.sort((a, b) => a.t - b.t) }
  await writeCache(songId, next)
  return next
}

export async function deleteLyrics(id: string): Promise<void> {
  try {
    if (isNative) await Filesystem.deleteFile({ path: file(id), directory: Directory.Data })
    else localStorage.removeItem(`stemkit:${file(id)}`)
  } catch {
    /* none */
  }
}
