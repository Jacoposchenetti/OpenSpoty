import { loadHistory } from './history'
import { nameParts } from './media'
import { loadRecents } from './recents'
import type { Playlist, Song } from './types'

/* Suggestions while typing in Cerca: what is yours first (songs, albums and
   playlists you saved, your artists, what you played lately, past searches),
   then YouTube's. "this" -> "This Old Dog" before "this halloween". */

export interface Suggestion {
  text: string
  mine: boolean
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

const DAY = 86400_000

/** your candidates for `q`, best first */
function mine(q: string, songs: Song[], playlists: Playlist[], artists: Array<{ name: string }>): string[] {
  const fq = fold(q)
  if (!fq) return []
  const score = new Map<string, { text: string; best: number; n: number }>()
  const add = (text: string | undefined, weight: number) => {
    if (!text) return
    const f = fold(text)
    if (!f || f === fq) return
    let m = 0
    if (f.startsWith(fq)) m = 6
    else if (f.split(' ').some((w) => w.startsWith(fq))) m = 3
    else if (fq.length >= 3 && f.includes(fq)) m = 1
    if (!m) return
    const cur = score.get(f)
    score.set(f, { text: cur?.text ?? text, best: Math.max(cur?.best ?? 0, m + weight), n: (cur?.n ?? 0) + 1 })
  }
  const now = Date.now()
  const recency = (at?: number) => (!at ? 0 : now - at < 7 * DAY ? 3 : now - at < 30 * DAY ? 1.5 : 0.5)
  for (const p of playlists) add(p.name, 3) // also the albums you saved
  for (const a of artists) add(a.name, 3)
  for (const s of songs) {
    const { name, artist } = nameParts(s.title)
    const w = 1.5 + (s.liked ? 1.5 : 0) + recency(s.playedAt)
    add(name, w)
    add(artist, w * 0.8)
    for (const a of s.artists ?? []) add(a.name, w * 0.8)
  }
  for (const h of loadHistory().slice(0, 40)) {
    const { name, artist } = nameParts(h.title)
    add(name, 2 + recency(h.at))
    add(artist, 1.5 + recency(h.at))
    if (h.episode) add(h.episode.podcast, 2 + recency(h.at))
  }
  for (const r of loadRecents()) add(r.title, 2.5)
  // the same name from several places (an artist with many of your songs…) gains a little, up to +2
  const total = (x: { best: number; n: number }) => x.best + Math.min(2, 0.5 * (x.n - 1))
  return [...score.values()].sort((a, b) => total(b) - total(a)).map((x) => x.text)
}

/** yours first (up to 4), then YouTube's, without repeats: 6 in all */
export function mergeSuggestions(q: string, web: string[], songs: Song[], playlists: Playlist[], artists: Array<{ name: string }>): Suggestion[] {
  const out: Suggestion[] = []
  const seen = new Set<string>()
  for (const text of mine(q, songs, playlists, artists).slice(0, 4)) {
    seen.add(fold(text))
    out.push({ text, mine: true })
  }
  for (const text of web) {
    if (out.length >= 6) break
    if (seen.has(fold(text))) continue
    seen.add(fold(text))
    out.push({ text, mine: false })
  }
  return out
}

/** only yours (before YouTube answers, or offline) */
export const localSuggestions = (q: string, songs: Song[], playlists: Playlist[], artists: Array<{ name: string }>) =>
  mergeSuggestions(q, [], songs, playlists, artists)
