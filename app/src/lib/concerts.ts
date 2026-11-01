import { engine, type SpConcert } from './engine'
import type { Song } from './types'

/* "Concerti vicino a te" (Home): the upcoming concerts of the artists you
   listen to and follow (Spotify's artist pages list them), kept when the city
   is within RADIUS_KM of the place in your profile. Places become coordinates
   through Open-Meteo's free geocoding (only city names are sent). */

export const RADIUS_KM = 150

export interface NearConcert extends SpConcert {
  artist: string
  artistUri: string
  km: number
}

type Point = { lat: number; lon: number } | null

const GEO_KEY = 'stemkit:geo'
let geo: Record<string, Point> = (() => {
  try {
    return JSON.parse(localStorage.getItem(GEO_KEY) ?? '{}') as Record<string, Point>
  } catch {
    return {}
  }
})()

async function locate(place: string): Promise<Point> {
  const key = place.trim().toLowerCase()
  if (!key) return null
  if (key in geo) return geo[key]
  const name = place.split(',')[0].trim() // "Roma, Italia" -> "Roma"
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=it&format=json`)
  if (!r.ok) throw new Error(`geocoding ${r.status}`)
  const j = (await r.json()) as { results?: Array<{ latitude: number; longitude: number }> }
  const p = j.results?.length ? { lat: j.results[0].latitude, lon: j.results[0].longitude } : null
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

/** the artists to look at: followed first, then the most present in what you play and keep */
export function concertArtists(songs: Song[], followed: Array<{ id: string; name: string }>, recent: Array<{ uri: string; name: string }>, max = 40) {
  const out = new Map<string, string>()
  for (const a of followed) if (a.id.startsWith('spotify:artist:')) out.set(a.id, a.name)
  for (const a of recent) out.set(a.uri, a.name)
  const count = new Map<string, { name: string; n: number }>()
  for (const s of songs) {
    for (const a of s.artists ?? []) {
      if (!a.uri) continue
      const c = count.get(a.uri) ?? { name: a.name, n: 0 }
      c.n += 1 + (s.liked ? 2 : 0)
      count.set(a.uri, c)
    }
  }
  for (const [uri, c] of [...count.entries()].sort((a, b) => b[1].n - a[1].n)) {
    if (out.size >= max) break
    if (!out.has(uri)) out.set(uri, c.name)
  }
  return [...out.entries()].slice(0, max).map(([uri, name]) => ({ uri, name }))
}

/** upcoming concerts near `place`, soonest first */
export async function nearbyConcerts(place: string, artists: Array<{ uri: string; name: string }>): Promise<NearConcert[]> {
  const home = await locate(place)
  if (!home) throw new Error('place')
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
        const d = km(home, p)
        if (d <= RADIUS_KM) found.push({ ...c, artist: a.name, artistUri: a.uri, km: Math.round(d) })
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
