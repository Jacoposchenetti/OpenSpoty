import { engine } from './engine'
import { isLocalPath, originalRef } from './media'
import { readCacheJson, writeCacheJson } from './storage'
import type { Song } from './types'

/* The beat of a song and its meter bar by bar (core/Rhythm.java: Beat This!,
   then the bars). Worked out once, then saved like the chords. */

export interface RhythmData {
  version: number
  beats: number[] // s, in the song's own time
  meter: number[] // beats in the bar of each beat
  pos: number[] // place of each beat in its bar (0 = the "one")
}

const file = (id: string) => `rhythm/${id}.json`

/** the whole song (the drums too): its original, or all its stems */
function sources(song: Song): string[] {
  const orig = originalRef(song)
  if (orig) return [orig]
  return song.stems.map((s) => song.files[s]).filter(isLocalPath)
}

export async function getRhythm(song: Song, onProgress: (pct: number) => void, force = false): Promise<RhythmData> {
  if (!force) {
    const cached = await readCacheJson<RhythmData>(file(song.id))
    if (cached?.beats?.length) return cached
  }
  const paths = sources(song)
  if (!paths.length) throw new Error('Nessun audio per questa canzone')
  const data = await engine.rhythm(song.id, paths, onProgress)
  await writeCacheJson(file(song.id), data)
  return data
}

/** the beat playing at t: its index (or -1 before the first / long after the last) */
export function beatAt(r: RhythmData, t: number): number {
  const b = r.beats
  if (!b.length || t < b[0] - 0.05 || t > b[b.length - 1] + 2.5) return -1
  let lo = 0,
    hi = b.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (b[mid] <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** beats per minute around beat i (median of the nearby gaps: follows the song speeding up or slowing down) */
export function bpmAt(r: RhythmData, i: number): number {
  const gaps: number[] = []
  for (let k = Math.max(1, i - 3); k <= Math.min(r.beats.length - 1, i + 4); k++) gaps.push(r.beats[k] - r.beats[k - 1])
  if (!gaps.length) return 0
  gaps.sort((a, b) => a - b)
  return 60 / gaps[gaps.length >> 1]
}
