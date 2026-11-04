import { useSyncExternalStore } from 'react'
import { nameParts } from './media'
import { isNative, StemKitNative } from './native'
import type { Song } from './types'

/* A few seconds of the song's music video looping in place of the cover (like
   Spotify's Canvas): streamed from YouTube while the player is open, never saved.
   Switched off from the player's ⋮ ("Video"), for whoever saves data. */

const KEY = 'stemkit:canvas'
const NONE_KEY = 'stemkit:canvas-none' // songs with no video: not looked up again for a month
const subs = new Set<() => void>()

let on = (() => {
  try {
    return localStorage.getItem(KEY) !== '0'
  } catch {
    return true
  }
})()

export function setVideoOn(v: boolean) {
  on = v
  try {
    localStorage.setItem(KEY, v ? '1' : '0')
  } catch {
    /* private mode */
  }
  subs.forEach((f) => f())
}

export function useVideoOn(): boolean {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => on
  )
}

function noneMap(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(NONE_KEY) ?? '{}') as Record<string, number>
  } catch {
    return {}
  }
}

// stream addresses last a few hours: kept for this session only
const found = new Map<string, Promise<string | null>>()

/** the address of the song's video (null: none, or not for this song) */
export function songVideo(song: Song): Promise<string | null> {
  if (!isNative || song.episode) return Promise.resolve(null)
  const at = noneMap()[song.id]
  if (at && Date.now() - at < 30 * 86400_000) return Promise.resolve(null)
  let p = found.get(song.id)
  if (!p) {
    const { name, artist } = nameParts(song.title)
    const artists = song.artists?.map((a) => a.name).join(', ') || artist
    p = StemKitNative.musicVideo({ title: name, artist: artists, duration: Math.round(song.duration || 0) })
      .then((v) => v.url)
      .catch((e: unknown) => {
        // "no video" is remembered; a network error may be gone next time
        if (/nessun video/.test(e instanceof Error ? e.message : String(e))) {
          try {
            localStorage.setItem(NONE_KEY, JSON.stringify({ ...noneMap(), [song.id]: Date.now() }))
          } catch {
            /* full */
          }
        }
        found.delete(song.id)
        return null
      })
    found.set(song.id, p)
  }
  return p
}
