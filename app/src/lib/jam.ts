import { useSyncExternalStore } from 'react'
import { isNative } from './native'
import { StemPlayer, type PlayerSpec } from './player'

/* "Jam", like Spotify's: this phone hosts a shared queue (android/.../Jam.java)
   that friends on the same Wi-Fi fill, from the browser (QR / link) or from
   their own OpenSpoty (found on the network). The queue and the controls live
   natively, so the Jam goes on with the screen locked; here the app only shows
   it and, as a guest, talks to another phone's Jam. */

export interface JamItem {
  key: string
  by: string
  songId: string
  title: string
  name: string
  artist: string
  art: string
  duration: number
}

export interface JamNow {
  songId: string | null
  title: string
  name: string
  artist: string
  art: string
  playing: boolean
  loading: boolean
  pos: number
  dur: number
}

export interface JamState {
  active: boolean
  host?: string
  allowControl?: boolean
  url?: string
  guests?: string[]
  queue?: JamItem[]
  now?: JamNow
}

/* ------------------------------------------------------------ hosting */

let hosted: JamState = { active: false }
const subs = new Set<() => void>()
const publish = (s: JamState) => {
  hosted = s
  subs.forEach((f) => f())
}

if (isNative) {
  void StemPlayer.addListener('player', (e) => {
    if (e.type === 'jam') publish(e as unknown as JamState)
  })
  void StemPlayer.jamState()
    .then(publish)
    .catch(() => undefined)
}

/** the Jam this phone hosts (active: false when none) */
export function useHostedJam(): JamState {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => hosted
  )
}

export const jamActive = () => hosted.active

/** guests and position change without events: re-read while the Jam is on screen */
export const refreshJam = () =>
  StemPlayer.jamState()
    .then(publish)
    .catch(() => undefined)

const NAME_KEY = 'stemkit:jam-name'
export function jamName(): string {
  try {
    return localStorage.getItem(NAME_KEY) || ''
  } catch {
    return ''
  }
}
export function setJamName(n: string) {
  try {
    localStorage.setItem(NAME_KEY, n)
  } catch {
    /* private mode */
  }
}

export async function startJam(host: string, allowControl: boolean) {
  publish(await StemPlayer.jamStart({ host, allowControl }))
}

export async function stopJam() {
  await StemPlayer.jamStop()
  publish({ active: false })
}

/** the host's own "Metti in coda" during a Jam */
export const jamAddSpec = (spec: PlayerSpec) => StemPlayer.jamAdd({ spec, by: jamName() || 'Host' })

/* ------------------------------------------------------------ joining someone's Jam */

export interface FoundJam {
  name: string
  url: string
}

/** a Jam link, from the QR or pasted: the address and its key */
export function parseJamLink(text: string): string | null {
  const m = text.trim().match(/^https?:\/\/[\w.-]+(?::\d+)?\/?\?k=[0-9a-f]+/i)
  return m ? m[0] : null
}

/** someone else's Jam, through Java (the app's page may not call plain http) */
export class JamClient {
  readonly base: string
  readonly key: string
  constructor(
    url: string,
    readonly who: string
  ) {
    const u = new URL(url)
    this.base = `${u.protocol}//${u.host}/`
    this.key = u.searchParams.get('k') ?? ''
  }

  private path(p: string) {
    return `${p}${p.includes('?') ? '&' : '?'}k=${encodeURIComponent(this.key)}&who=${encodeURIComponent(this.who)}`
  }

  private async call<T>(p: string, body?: unknown): Promise<T> {
    const r = await StemPlayer.jamRequest({ base: this.base, path: this.path(p), method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined })
    return JSON.parse(r.text) as T
  }

  state = () => this.call<JamState>('/api/state')
  add = (t: { title: string; artists?: string[]; duration?: number; image?: string; videoId?: string }) => this.call<{ ok: boolean }>('/api/add', t)
  control = (action: 'play' | 'pause' | 'next' | 'prev' | 'remove' | 'up' | 'down', key?: string) => this.call<{ ok: boolean }>('/api/control', { action, key })
  /** artwork of a song the host has saved on its phone */
  art = (a: string, songId: string | null) => (a.startsWith('/') ? `${this.base}${this.path(`api/art?id=${encodeURIComponent(songId ?? '')}`)}` : a)
}
