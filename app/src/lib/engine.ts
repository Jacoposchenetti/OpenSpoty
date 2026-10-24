import { isDesktop, isNative, StemKitNative, type SeparationEvent, type YtResult } from './native'
import { StemPlayer } from './player'

/* Search, download and split on the device the app runs on: the phone's own
   Java code, or the PC (bridge/pc_app.py runs the same Java code there). */

export interface SpotifyList {
  name: string
  image?: string
  owner?: string
  tracks: Array<{ title: string; artist: string; duration: number; uri?: string; image?: string; artistUri?: string }>
}

export interface Match {
  videoId: string
  title: string
  channel: string
  duration: number
  score: number
}

/* Spotify catalogue (SpotifyCatalog.java): names and artwork for artist / album pages */
export interface SpTrack {
  uri: string
  title: string
  artists: string[]
  artistUris: string[]
  duration: number
  album?: string
  albumUri?: string
  image?: string
  plays?: string
}

export interface SpRelease {
  uri: string
  name: string
  type: string
  image: string
  year?: number
  date?: string // YYYY-MM-DD
  artists: string[]
  trackCount?: number
}

export interface SpArtistRef {
  uri: string
  name: string
  image: string
}

export interface SpPlaylistRef {
  uri: string
  name: string
  image: string
  owner?: string
  description?: string
}

export interface SpArtist extends SpArtistRef {
  header: string
  listeners?: number
  bio?: string
  topTracks: SpTrack[]
  albums: SpRelease[]
  singles: SpRelease[]
  compilations: SpRelease[]
  latest?: SpRelease
  related: SpArtistRef[]
  appearsOn?: SpRelease[]
  playlists?: SpPlaylistRef[]
}

export interface SpAlbum extends SpRelease {
  tracks: SpTrack[]
}

export type SpTop =
  | (SpTrack & { kind: 'track' })
  | (SpArtistRef & { kind: 'artist' })
  | (SpRelease & { kind: 'album' })
  | (SpPlaylistRef & { kind: 'playlist' })

export interface SpSearch {
  artists: SpArtistRef[]
  albums: SpRelease[]
  tracks: SpTrack[]
  playlists?: SpPlaylistRef[]
  /** Spotify's "top results": every kind together, most relevant first */
  top?: SpTop[]
}

/* searches and pages already seen come back at once (kept in memory, and on
   disk for a while: 1 h for searches, a day for artists, a week for albums) */
const memo = new Map<string, { at: number; value: unknown }>()
async function remember<T>(key: string, ttl: number, fetcher: () => Promise<T>): Promise<T> {
  const now = Date.now()
  let hit = memo.get(key)
  if (!hit) {
    try {
      const raw = localStorage.getItem(`stemkit:c:${key}`)
      if (raw) hit = JSON.parse(raw) as { at: number; value: unknown }
    } catch {
      /* private mode */
    }
  }
  if (hit && now - hit.at < ttl) return hit.value as T
  const value = await fetcher()
  memo.set(key, { at: now, value })
  try {
    localStorage.setItem(`stemkit:c:${key}`, JSON.stringify({ at: now, value }))
  } catch {
    // storage full: forget the cached pages and keep going
    for (const k of Object.keys(localStorage)) if (k.startsWith('stemkit:c:')) localStorage.removeItem(k)
  }
  return value
}

const SIX = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']

async function pc<T>(op: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/pc/${op}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(data.error || `Errore ${res.status}`)
  return data
}

/* the PC has no push events: poll its separation queue while someone listens */
const sepListeners = new Set<(e: SeparationEvent) => void>()
let lastSep = ''
let sepTimer: number | null = null
function pollSeparation() {
  if (sepTimer !== null) return
  const tick = async () => {
    try {
      const e = await pc<SeparationEvent | { state: 'idle' }>('separation')
      const key = JSON.stringify(e)
      if (e.state !== 'idle' && key !== lastSep) sepListeners.forEach((cb) => cb(e as SeparationEvent))
      lastSep = key
    } catch {
      /* bridge restarting */
    }
    sepTimer = window.setTimeout(tick, 1500)
  }
  sepTimer = window.setTimeout(tick, 0)
}

export const engine = {
  /** false in a plain browser (development) */
  available: isNative || isDesktop,

  search: (query: string): Promise<YtResult[]> =>
    remember(`yt:${query.toLowerCase()}`, 3600_000, async () =>
      isNative ? (await StemKitNative.ytSearch({ query })).results : (await pc<{ results: YtResult[] }>('search', { query })).results
    ),

  async spotifyQuery(url: string): Promise<string> {
    return (isNative ? await StemKitNative.spotifyQuery({ url }) : await pc<{ query: string }>('spotifyQuery', { url })).query
  },

  spotifyList: (url: string): Promise<SpotifyList> => (isNative ? StemKitNative.spotifyList({ url }) : pc('spotifyList', { url })),

  matchSong: (t: { title: string; artist: string; duration: number }): Promise<Match> => (isNative ? StemKitNative.matchSong(t) : pc('match', t)),

  /** the original audio only, for listening (writes songs/<songId>/meta.json) */
  downloadYoutube: (o: { videoId: string; songId: string; title: string }): Promise<{ original: string; duration: number }> =>
    isNative ? StemKitNative.downloadYoutube(o) : pc('download', o),

  /** queue a split: of a downloaded song (existing) or straight from YouTube */
  async separate(o: { songId: string; title: string; youtubeId?: string; existing?: boolean }): Promise<void> {
    if (isNative) await StemKitNative.separate({ ...o, stems: SIX, quality: 'flac' })
    else await pc('separate', o)
  },

  async cancelSeparation(all = false): Promise<void> {
    if (isNative) await StemKitNative.cancelSeparation({ all })
    else await pc('cancel', { all })
  },

  async separationStatus(): Promise<SeparationEvent | null> {
    const e = isNative ? await StemKitNative.separationStatus() : await pc<SeparationEvent | { state: 'idle' }>('separation')
    return e.state === 'idle' ? null : (e as SeparationEvent)
  },

  onSeparation(cb: (e: SeparationEvent) => void): () => void {
    if (isNative) {
      const h = StemKitNative.addListener('separation', cb)
      return () => void h.then((x) => x.remove())
    }
    if (!isDesktop) return () => undefined
    sepListeners.add(cb)
    pollSeparation()
    return () => sepListeners.delete(cb)
  },

  /** null = could not measure; undefined = a stream not cached yet (try after it is played) */
  async measureLoudness(paths: string[]): Promise<number | null | undefined> {
    if (isNative) {
      const r = (await StemPlayer.measureLoudness({ paths })) as { lufs: number | null; notCached?: boolean }
      return r.notCached ? undefined : r.lufs
    }
    return (await pc<{ lufs: number | null }>('loudness', { paths })).lufs
  },

  /** prepare the streams of songs likely to be played: addresses looked up, the first
      `prefetch` songs fetched whole into the cache (Spotify does the same) */
  warm(videoIds: string[], prefetch = 0): void {
    const ids = [...new Set(videoIds)].slice(0, 6)
    if (!ids.length) return
    if (isNative) void StemKitNative.warmStreams({ videoIds: ids, prefetch }).catch(() => undefined)
    else if (isDesktop && prefetch) void pc('warm', { videoIds: ids, prefetch }).catch(() => undefined)
  },

  /** podcasts (core/Podcasts.java): Apple's search, then the podcast's own feed */
  podcastSearch: (query: string): Promise<import('./podcasts').Podcast[]> =>
    remember(`pod:${query.toLowerCase()}`, 3600_000, async () =>
      isNative ? (await StemKitNative.podcastSearch({ query })).results : (await pc<{ results: import('./podcasts').Podcast[] }>('podcastSearch', { query })).results
    ),
  podcastFeed: (url: string): Promise<import('./podcasts').PodcastFeed> =>
    remember(`feed:${url}`, 1800_000, () => (isNative ? StemKitNative.podcastFeed({ url }) : pc('podcastFeed', { url }))),

  /** what to suggest while typing (YouTube's autocomplete) */
  async suggest(query: string): Promise<string[]> {
    return (isNative ? await StemKitNative.suggest({ query }) : await pc<{ suggestions: string[] }>('suggest', { query })).suggestions
  },

  /** a Spotify playlist's tracks (cached for a day) */
  spPlaylist: (uri: string): Promise<SpotifyList> =>
    remember(uri, 86400_000, () => {
      const url = `https://open.spotify.com/playlist/${uri.split(':').pop()}`
      return isNative ? StemKitNative.spotifyList({ url }) : pc('spotifyList', { url })
    }),

  spSearch: (query: string): Promise<SpSearch> =>
    remember(`sp2:${query.toLowerCase()}`, 86400_000, () => (isNative ? StemKitNative.spSearch({ query }) : pc('spSearch', { query }))),
  spArtist: (uri: string): Promise<SpArtist> => remember(uri, 86400_000, () => (isNative ? StemKitNative.spArtist({ uri }) : pc('spArtist', { uri }))),
  spAlbum: (uri: string): Promise<SpAlbum> => remember(uri, 7 * 86400_000, () => (isNative ? StemKitNative.spAlbum({ uri }) : pc('spAlbum', { uri }))),

  /** chords of a song (core/ChordRecognizer.java), with progress in percent */
  async chords(songId: string, paths: string[], onProgress: (pct: number) => void): Promise<import('./chords').ChordData> {
    if (!isNative) return pc('chords', { paths })
    const h = StemPlayer.addListener('chords', (e) => e.songId === songId && onProgress(e.pct))
    try {
      return await StemPlayer.chords({ songId, paths })
    } finally {
      void h.then((x) => x.remove())
    }
  },

  /** when each line of unsynced lyrics is sung (core/LyricsAligner.java); progress in percent */
  async alignLyrics(songId: string, path: string, lines: string[], onProgress: (pct: number, downloading: boolean) => void): Promise<number[]> {
    if (!isNative) return (await pc<{ times: number[] }>('alignLyrics', { path, lines })).times
    const h = StemPlayer.addListener('align', (e) => e.songId === songId && onProgress(e.pct, e.downloading))
    try {
      return (await StemPlayer.alignLyrics({ songId, path, lines })).times
    } finally {
      void h.then((x) => x.remove())
    }
  },

  /** 30 s of a podcast episode's words from `from` (core/Whisper.java); lang '' = Whisper tells */
  async transcribe(
    songId: string,
    path: string,
    from: number,
    lang: string,
    onProgress?: (pct: number, downloading: boolean) => void
  ): Promise<{ lang: string; segments: Array<{ a: number; b: number; text: string }>; next: number; ended: boolean }> {
    if (!isNative) return pc('transcribe', { path, from, lang })
    const h = StemPlayer.addListener('align', (e) => e.songId === songId && onProgress?.(e.pct, e.downloading))
    try {
      return await StemPlayer.transcribe({ songId, path, from, lang })
    } finally {
      void h.then((x) => x.remove())
    }
  },

  /** lines in another language (core/Translate.java) */
  async translate(texts: string[], to: string): Promise<string[]> {
    return (isNative ? await StemPlayer.translate({ texts, to }) : await pc<{ texts: string[] }>('translate', { texts, to })).texts
  },

  /** saves the YouTube artwork next to the song, for offline use */
  async fetchCover(songId: string, videoId: string): Promise<string> {
    if (isNative) {
      const path = `songs/${songId}/cover.jpg`
      await StemKitNative.download({ id: `cover:${songId}`, url: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`, pin: '', path })
      return path
    }
    return (await pc<{ path: string }>('cover', { songId, videoId })).path
  }
}
