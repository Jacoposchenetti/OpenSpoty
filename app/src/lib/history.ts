import type { Song } from './types'

/* What you played lately, for Home ("Ascoltati di recente", artists, podcasts):
   kept here because songs only heard (streamed, not saved) are forgotten on restart. */

const KEY = 'stemkit:history'
const MAX = 60

export type HistoryEntry = Pick<Song, 'id' | 'title' | 'duration' | 'art' | 'cover' | 'artists' | 'artistUri' | 'albumUri' | 'spotifyUri' | 'episode'> & { at: number }

export function loadHistory(): HistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as HistoryEntry[]
  } catch {
    return []
  }
}

export function pushHistory(s: Song) {
  const e: HistoryEntry = {
    id: s.id,
    title: s.title,
    duration: s.duration,
    art: s.art,
    cover: s.cover,
    artists: s.artists,
    artistUri: s.artistUri,
    albumUri: s.albumUri,
    spotifyUri: s.spotifyUri,
    episode: s.episode,
    at: Date.now()
  }
  const list = [e, ...loadHistory().filter((x) => x.id !== s.id)].slice(0, MAX)
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* full */
  }
}

/** a history entry as a playable song (streamed again like the first time) */
export const historySong = (e: HistoryEntry): Song => ({ ...e, stems: [], files: {}, source: 'device', addedAt: e.at })
