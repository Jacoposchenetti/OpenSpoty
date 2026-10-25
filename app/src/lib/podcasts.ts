import { Directory, Filesystem } from '@capacitor/filesystem'
import { engine } from './engine'
import { isNative, StemKitNative } from './native'
import type { Song } from './types'
import { localeTag } from './i18n'

/* Podcasts: found with Apple's public search, played from the podcast's own
   feed (core/Podcasts.java). An episode plays like a song (Song.episode), from
   where you left it; it can be kept on the phone for offline listening. */

export interface Podcast {
  feed: string
  name: string
  author: string
  image: string
  count?: number
}

export interface Episode {
  guid: string
  title: string
  date: number // ms
  duration: number // s
  url: string
  description: string
  image: string
}

export interface PodcastFeed extends Podcast {
  description: string
  episodes: Episode[]
}

export const podcastSearch = (q: string) => engine.podcastSearch(q)
export const podcastFeed = (feed: string) => engine.podcastFeed(feed)

/** the follow key of a podcast (followed podcasts live with the followed artists, synced with the PC) */
export const podcastKey = (feed: string) => `podcast:${feed}`

const hash = (s: string) => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** an episode as a song of the app: "Podcast – Episode", its audio from the podcast's server (or the phone) */
export function episodeSong(ep: Episode, pod: Podcast): Song {
  const id = `ep-${hash(pod.feed + '|' + ep.guid)}`
  const local = downloaded()[id]
  return {
    id,
    title: `${pod.name} – ${ep.title}`,
    duration: ep.duration,
    stems: [],
    files: {},
    source: 'device',
    addedAt: Date.now(),
    art: ep.image || pod.image,
    // Android plays only https (and most podcast hosts serve both)
    original: local ?? ep.url.replace(/^http:\/\//, 'https://'),
    episode: { feed: pod.feed, guid: ep.guid, podcast: pod.name, date: ep.date }
  }
}

// ------------------------------------------------------------ where you left each episode

interface Progress {
  pos: number
  dur: number
  at: number
}
const POS = 'stemkit:episodes'

function positions(): Record<string, Progress> {
  try {
    return JSON.parse(localStorage.getItem(POS) ?? '{}') as Record<string, Progress>
  } catch {
    return {}
  }
}

export function saveProgress(id: string, pos: number, dur: number) {
  const all = positions()
  all[id] = { pos: Math.round(pos), dur: Math.round(dur), at: Date.now() }
  // keep the 300 most recent
  const keep = Object.entries(all)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, 300)
  try {
    localStorage.setItem(POS, JSON.stringify(Object.fromEntries(keep)))
  } catch {
    /* private mode */
  }
}

/** where to start: where you stopped (from the top if it was finished) */
export function resumeAt(id: string): number {
  const p = positions()[id]
  return p && !isDone(p) ? Math.max(0, p.pos - 3) : 0
}

const isDone = (p: Progress) => p.dur > 0 && p.pos >= p.dur - 45

/** 0..1 heard, and finished */
export function progressOf(id: string): { frac: number; done: boolean } | null {
  const p = positions()[id]
  if (!p || !p.dur) return null
  return { frac: Math.min(1, p.pos / p.dur), done: isDone(p) }
}

// ------------------------------------------------------------ on the phone (offline)

const DL = 'stemkit:episode-files'

function downloaded(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(DL) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

export const isEpisodeDownloaded = (id: string) => id in downloaded()

export async function downloadEpisode(song: Song, url: string): Promise<void> {
  if (!isNative) return
  const ext = (url.split('?')[0].match(/\.(mp3|m4a|aac|ogg|opus)$/i)?.[1] ?? 'mp3').toLowerCase()
  const path = `episodes/${song.id}.${ext}`
  await StemKitNative.download({ id: `ep:${song.id}`, url: url.replace(/^http:\/\//, 'https://'), pin: '', path })
  const all = downloaded()
  all[song.id] = path
  localStorage.setItem(DL, JSON.stringify(all))
}

export async function removeEpisode(id: string): Promise<void> {
  const all = downloaded()
  const path = all[id]
  if (!path) return
  delete all[id]
  localStorage.setItem(DL, JSON.stringify(all))
  if (isNative) await Filesystem.deleteFile({ path, directory: Directory.Data }).catch(() => undefined)
}

/** "3 ott", "12 mar 2024" */
export function shortDate(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const includeYear = d.getFullYear() !== new Date().getFullYear()
  return new Intl.DateTimeFormat(localeTag(), { day: 'numeric', month: 'short', ...(includeYear ? { year: 'numeric' as const } : {}) }).format(d)
}

/** "1 h 12 min", "48 min" */
export function longTime(s: number): string {
  const m = Math.round(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`
}
