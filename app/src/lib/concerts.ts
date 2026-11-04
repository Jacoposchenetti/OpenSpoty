import { useSyncExternalStore } from 'react'
import { engine, type SpConcert } from './engine'
import { loadHistory } from './history'
import { recentArtists } from './listens'
import type { Playlist, Song } from './types'

/* "Concerti vicino a te" (Home): the upcoming concerts of your artists (Spotify's
   artist pages list them), near you. Its ⋮ sets where (a city, or your position),
   how near (a radius, or Italian regions) and whose concerts (lists you pick,
   artists you follow, of your library, played lately, that you might like).
   Places become coordinates through Open-Meteo's free geocoding (only city names
   are sent; your position never leaves the phone). */

export interface NearConcert extends SpConcert {
  artist: string
  artistUri: string
  km: number
}

/* ------------------------------------------------------------ settings */

export interface ConcertSettings {
  /** your position instead of the profile's city */
  useGps: boolean
  gps?: { lat: number; lon: number }
  mode: 'radius' | 'regions'
  radius: number // km
  regions: string[]
  sources: { followed: boolean; library: boolean; recent: boolean; suggested: boolean; playlists: string[] }
}

const SET_KEY = 'stemkit:concerts'
const DEFAULTS: ConcertSettings = {
  useGps: false,
  mode: 'radius',
  radius: 150,
  regions: [],
  sources: { followed: true, library: true, recent: true, suggested: false, playlists: [] }
}
const subs = new Set<() => void>()
let settings: ConcertSettings = (() => {
  try {
    const s = JSON.parse(localStorage.getItem(SET_KEY) ?? 'null') as Partial<ConcertSettings> | null
    return { ...DEFAULTS, ...s, sources: { ...DEFAULTS.sources, ...s?.sources } }
  } catch {
    return DEFAULTS
  }
})()

export function setConcertSettings(p: Partial<ConcertSettings>) {
  settings = { ...settings, ...p }
  try {
    localStorage.setItem(SET_KEY, JSON.stringify(settings))
  } catch {
    /* private mode */
  }
  subs.forEach((f) => f())
}

export function useConcertSettings(): ConcertSettings {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => settings
  )
}

export const REGIONS = [
  'Abruzzo', 'Basilicata', 'Calabria', 'Campania', 'Emilia-Romagna', 'Friuli-Venezia Giulia', 'Lazio', 'Liguria', 'Lombardia', 'Marche',
  'Molise', 'Piemonte', 'Puglia', 'Sardegna', 'Sicilia', 'Toscana', 'Trentino-Alto Adige', 'Umbria', "Valle d'Aosta", 'Veneto'
]

/** your position (coarse: a city's worth is enough), asked to the phone */
export function currentPosition(): Promise<{ lat: number; lon: number }> {
  return new Promise((ok, fail) =>
    navigator.geolocation.getCurrentPosition(
      (p) => ok({ lat: Math.round(p.coords.latitude * 1000) / 1000, lon: Math.round(p.coords.longitude * 1000) / 1000 }),
      (e) => fail(new Error(e.code === 1 ? 'permesso' : 'posizione')),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 3600_000 }
    )
  )
}

/* ------------------------------------------------------------ places */

type Place = { lat: number; lon: number; region: string } | null

const GEO_KEY = 'stemkit:geo2'
let geo: Record<string, Place> = (() => {
  try {
    return JSON.parse(localStorage.getItem(GEO_KEY) ?? '{}') as Record<string, Place>
  } catch {
    return {}
  }
})()

/** "Roma" -> coordinates and region (cached) */
async function locate(place: string): Promise<Place> {
  const key = place.trim().toLowerCase()
  if (!key) return null
  if (key in geo) return geo[key]
  const name = place.split(',')[0].trim() // "Roma, Italia" -> "Roma"
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=it&format=json`)
  if (!r.ok) throw new Error(`geocoding ${r.status}`)
  const j = (await r.json()) as { results?: Array<{ latitude: number; longitude: number; admin1?: string; country_code?: string }> }
  const x = j.results?.[0]
  const p = x ? { lat: x.latitude, lon: x.longitude, region: x.country_code === 'IT' ? x.admin1 ?? '' : '' } : null
  geo = { ...geo, [key]: p }
  try {
    localStorage.setItem(GEO_KEY, JSON.stringify(geo))
  } catch {
    /* full */
  }
  return p
}

function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.asin(Math.sqrt(h))
}

/** Open-Meteo's region names vary a little ("Trentino-Alto Adige/Südtirol"): compared loosely */
const sameRegion = (a: string, b: string) => {
  const f = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '').slice(0, 8)
  return !!a && f(a) === f(b)
}

/* ------------------------------------------------------------ whose concerts */

type Artist = { uri: string; name: string }

/** the artists to look at, from the sources you picked (at most `max`) */
export async function concertArtists(
  s: ConcertSettings,
  songs: Song[],
  playlists: Playlist[],
  followed: Array<{ id: string; name: string }>,
  max = 50
): Promise<Artist[]> {
  const out = new Map<string, string>()
  const put = (a: { uri?: string; name: string }) => a.uri?.startsWith('spotify:artist:') && out.size < max && !out.has(a.uri) && out.set(a.uri, a.name)
  const byId = new Map(songs.map((x) => [x.id, x]))
  // every artist of a song (with a Spotify page), most frequent first
  const ranked = (list: Song[]) => {
    const n = new Map<string, { name: string; n: number }>()
    for (const x of list) for (const a of x.artists ?? []) if (a.uri) n.set(a.uri, { name: a.name, n: (n.get(a.uri)?.n ?? 0) + 1 + (x.liked ? 2 : 0) })
    return [...n.entries()].sort((a, b) => b[1].n - a[1].n).map(([uri, v]) => ({ uri, name: v.name }))
  }
  for (const pid of s.sources.playlists) {
    const p = playlists.find((x) => x.id === pid)
    if (p) ranked(p.songIds.flatMap((id) => byId.get(id) ?? [])).forEach(put)
  }
  if (s.sources.followed) for (const a of followed) put({ uri: a.id, name: a.name })
  if (s.sources.recent) {
    for (const h of loadHistory()) for (const a of h.artists ?? []) put(a)
  }
  if (s.sources.library) ranked(songs).forEach(put)
  if (s.sources.suggested) {
    // like the artists you played most in the last year: their related artists on Spotify
    const plays = recentArtists(365)
    const known = new Map<string, string>()
    for (const x of songs) for (const a of x.artists ?? []) if (a.uri) known.set(a.name.toLowerCase(), a.uri)
    const top = [...plays.entries()].sort((a, b) => b[1] - a[1]).flatMap(([name]) => known.get(name.toLowerCase()) ?? []).slice(0, 6)
    for (const uri of top) {
      const a = await engine.spArtist(uri).catch(() => null)
      for (const r of a?.related.slice(0, 5) ?? []) put(r)
    }
  }
  return [...out.entries()].map(([uri, name]) => ({ uri, name }))
}

/* ------------------------------------------------------------ the concerts */

/** the place the concerts are measured from: your position, or the profile's city */
export async function home(s: ConcertSettings, city: string): Promise<{ lat: number; lon: number } | null> {
  if (s.useGps) return s.gps ?? null
  return locate(city)
}

/** upcoming concerts within the radius (or the regions), soonest first */
export async function nearbyConcerts(s: ConcertSettings, city: string, artists: Artist[]): Promise<NearConcert[]> {
  const from = await home(s, city)
  if (!from && s.mode === 'radius') throw new Error('place')
  const found: NearConcert[] = []
  let next = 0
  const worker = async () => {
    while (next < artists.length) {
      const a = artists[next++]
      let list: SpConcert[] = []
      try {
        list = await engine.spConcerts(a.uri)
      } catch {
        continue
      }
      for (const c of list) {
        if (!c.city || new Date(c.date).getTime() < Date.now() - 86400_000) continue
        const p = await locate(c.city).catch(() => null)
        if (!p) continue
        const d = from ? Math.round(km(from, p)) : 0
        const ok = s.mode === 'regions' ? s.regions.some((r) => sameRegion(p.region, r)) : d <= s.radius
        if (ok) found.push({ ...c, artist: a.name, artistUri: a.uri, km: d })
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
  const seen = new Set<string>()
  return found.filter((c) => !seen.has(c.uri) && seen.add(c.uri)).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
}

/** a web search for the concert's tickets */
export const ticketsUrl = (c: NearConcert) =>
  `https://www.google.com/search?q=${encodeURIComponent(`${c.artist} ${c.venue} ${c.city} ${c.date.slice(0, 10)} biglietti`)}`

/** the venue on a map */
export const mapUrl = (c: NearConcert) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${c.venue}, ${c.city}`)}`
