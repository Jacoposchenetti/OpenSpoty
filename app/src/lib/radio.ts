import { songsFor } from './catalog'
import { libraryKeys, playlistPool, trackKey } from './home'
import type { Song } from './types'

/* "Riproduzione automatica", like Spotify: when a list ends, songs like the
   last ones played (their artists' hits and those of similar artists),
   never one already in the list. Also for the alarm ("Brani simili"). */

export async function similarSongs(seeds: Song[], exclude: Set<string>, getSong: (id: string) => Song | undefined, n = 10): Promise<Song[]> {
  const pool = await playlistPool(seeds)
  const had = libraryKeys(seeds)
  const picks = pool.filter((t) => !had.has(trackKey(t.artists[0] ?? '', t.title))).slice(0, n * 2)
  const songs = await songsFor(picks, getSong)
  const out: Song[] = []
  for (const s of songs) {
    if (out.length >= n) break
    if (!exclude.has(s.id) && !out.some((x) => x.id === s.id)) out.push(s)
  }
  return out
}

