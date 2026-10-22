import { Share } from '@capacitor/share'
import { youtubeIdOf, nameParts } from './media'
import { isNative } from './native'
import type { Song } from './types'

/* "Condividi", like Spotify: the phone's share sheet (WhatsApp, Telegram…),
   on the PC the system one, or the link copied. */

export async function share(o: { title: string; text?: string; url?: string }): Promise<'shared' | 'copied' | 'none'> {
  try {
    if (isNative) {
      await Share.share({ title: o.title, text: o.text, url: o.url, dialogTitle: 'Condividi' })
      return 'shared'
    }
    if (navigator.share) {
      await navigator.share({ title: o.title, text: o.text, url: o.url })
      return 'shared'
    }
    await navigator.clipboard.writeText([o.text, o.url].filter(Boolean).join(' '))
    return 'copied'
  } catch {
    return 'none' // closed without choosing
  }
}

const spotifyLink = (uri?: string) => {
  const m = uri?.match(/^spotify:(track|album|artist|playlist):(\w+)$/)
  return m ? `https://open.spotify.com/${m[1]}/${m[2]}` : undefined
}

/** a song: its Spotify page when we know it, otherwise YouTube Music */
export function shareSong(song: Song) {
  const { name, artist } = nameParts(song.title)
  const vid = youtubeIdOf(song.id)
  const url = spotifyLink(song.spotifyUri) ?? (vid ? `https://music.youtube.com/watch?v=${vid}` : undefined)
  return share({ title: name, text: artist ? `${name} – ${artist}` : name, url })
}

export const shareSpotify = (title: string, uri: string, text?: string) => share({ title, text: text ?? title, url: spotifyLink(uri) })

/** a playlist has no public page: its songs as a list, each with its link */
export function sharePlaylist(name: string, songs: Song[]) {
  const lines = songs.map((s, i) => {
    const vid = youtubeIdOf(s.id)
    const url = spotifyLink(s.spotifyUri) ?? (vid ? `https://music.youtube.com/watch?v=${vid}` : '')
    return `${i + 1}. ${s.title}${url ? ` ${url}` : ''}`
  })
  return share({ title: name, text: `🎵 ${name}\n\n${lines.join('\n')}` })
}
