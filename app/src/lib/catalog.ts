import { engine, type SpTrack } from './engine'
import type { Song } from './types'

/* A Spotify track becomes a playable song: the same recording found on
   YouTube Music (matchSong: same title, artist and length). Matches are
   remembered, so a page opens instantly the second time. */

const KEY = 'stemkit:matches'
let memo: Record<string, string> = {}
try {
  memo = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>
} catch {
  /* private mode */
}
const pending = new Map<string, Promise<string | null>>()

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(memo))
  } catch {
    /* full */
  }
}

export const songTitle = (t: SpTrack) => (t.artists[0] ? `${t.artists[0]} – ${t.title}` : t.title)

export function songFor(t: SpTrack, videoId: string): Song {
  return {
    id: `yt-${videoId}`,
    title: songTitle(t),
    duration: t.duration,
    stems: [],
    files: {},
    source: 'device',
    addedAt: Date.now(),
    art: t.image || undefined,
    artistUri: t.artistUris[0],
    spotifyUri: t.uri
  }
}

/** the YouTube video of a track (null if none fits) */
export function matchTrack(t: SpTrack): Promise<string | null> {
  if (t.uri in memo) return Promise.resolve(memo[t.uri])
  let p = pending.get(t.uri)
  if (!p) {
    p = engine
      .matchSong({ title: t.title, artist: t.artists.join(', '), duration: t.duration })
      .then((m) => {
        memo[t.uri] = m.videoId
        save()
        return m.videoId
      })
      .catch(() => null)
      .finally(() => pending.delete(t.uri))
    pending.set(t.uri, p)
  }
  return p
}

/** songs for a list of tracks, a few lookups at a time; tracks with no match are left out */
export async function songsFor(tracks: SpTrack[], known: (id: string) => Song | undefined): Promise<Song[]> {
  const out: (Song | null)[] = new Array(tracks.length).fill(null)
  let next = 0
  const worker = async () => {
    while (next < tracks.length) {
      const i = next++
      const vid = await matchTrack(tracks[i])
      if (vid) out[i] = known(`yt-${vid}`) ?? songFor(tracks[i], vid)
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
  return out.filter((s): s is Song => !!s)
}

export const isMatched = (t: SpTrack) => t.uri in memo
