import type { Song } from './types'

/* Where a song's audio is: a file on this device, or YouTube (streamed, like
   Spotify: StreamProxy.java on the phone, /api/pc/stream on the PC). */

export const youtubeIdOf = (songId: string) => songId.match(/^(?:yt|pc)-([\w-]{11})$/)?.[1] ?? null

/** a file of this device (not a stream, not a PC address) */
export const isLocalPath = (p?: string): p is string => !!p && !p.startsWith('bridge:') && !p.startsWith('stream:')

/** what plays the whole song: the downloaded file, else the stream */
export function originalRef(s: Song): string | undefined {
  if (s.original && !s.original.startsWith('bridge:')) return s.original
  const v = youtubeIdOf(s.id)
  return v ? `stream:${v}` : undefined
}

/** saved on this device (downloaded or split): plays offline */
export const isDownloaded = (s: Song) => isLocalPath(s.original) || s.stems.length > 0

/** "Artista – Titolo" shown like Spotify: the title, and the artist under it */
export function nameParts(title: string): { name: string; artist: string } {
  const m = title.match(/^(.+?)\s+[–-]\s+(.+)$/)
  return m ? { name: m[2].trim(), artist: m[1].trim() } : { name: title, artist: '' }
}

/** "Artista – Titolo" → "Artista" */
export function artistOf(title: string): string {
  const m = title.match(/^(.+?)\s+[–-]\s+.+$/)
  return m ? m[1].trim() : ''
}
