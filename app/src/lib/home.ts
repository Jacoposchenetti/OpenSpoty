import { engine, type SpArtistRef, type SpPlaylistRef, type SpRelease, type SpTrack } from './engine'
import { artistOf } from './media'
import type { Song } from './types'

/* The shelves of "Cerca", built from the artists you listen to most: their
   similar artists (none you already have), the playlists they are in, their
   newest releases, and the best songs of those new artists. */

export interface Home {
  artists: SpArtistRef[]
  playlists: SpPlaylistRef[]
  releases: SpRelease[]
}

const fold = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

const mainArtist = (s: Song) => artistOf(s.title).split(/,| feat\.| ft\.| & /i)[0].trim()

/** every artist with at least one song in your library (folded names) */
const knownArtists = (songs: Song[]) =>
  new Set(
    songs.flatMap((s) =>
      artistOf(s.title)
        .split(/,| feat\.| ft\.| & | x /i)
        .map((a) => fold(a))
        .filter(Boolean)
    )
  )

/** your artists, most listened first: songs count, liked ones and recent plays weigh more */
export function topArtists(songs: Song[], n = 8): string[] {
  const score = new Map<string, { name: string; s: number }>()
  const now = Date.now()
  for (const s of songs) {
    const name = mainArtist(s)
    if (!name) continue
    const k = fold(name)
    const recent = s.playedAt ? Math.max(0, 1 - (now - s.playedAt) / (30 * 86400_000)) * 3 : 0
    const cur = score.get(k) ?? { name, s: 0 }
    cur.s += 1 + (s.liked ? 3 : 0) + recent
    score.set(k, cur)
  }
  return [...score.values()].sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.name)
}

async function artistUri(name: string): Promise<string | null> {
  try {
    const r = await engine.spSearch(name)
    return (r.artists.find((a) => fold(a.name) === fold(name)) ?? r.artists[0])?.uri ?? null
  } catch {
    return null
  }
}

let memo: { key: string; home: Home } | null = null

export async function buildHome(songs: Song[]): Promise<Home> {
  const names = topArtists(songs)
  const key = `${names.join('|')}#${songs.length}`
  if (memo?.key === key) return memo.home
  const mine = knownArtists(songs)
  const pages = (
    await Promise.all(
      names.map(async (n) => {
        const uri = await artistUri(n)
        return uri ? engine.spArtist(uri).catch(() => null) : null
      })
    )
  ).filter((a): a is NonNullable<typeof a> => !!a)

  // similar artists: the more of your artists point at one, the higher it goes
  const votes = new Map<string, { a: SpArtistRef; n: number }>()
  pages.forEach((p, rank) =>
    p.related.forEach((a, i) => {
      if (mine.has(fold(a.name))) return
      const v = votes.get(a.uri) ?? { a, n: 0 }
      v.n += 1 / (1 + i / 5) / (1 + rank / 4)
      votes.set(a.uri, v)
    })
  )
  const artists = [...votes.values()].sort((x, y) => y.n - x.n).map((v) => v.a).slice(0, 15)

  // playlists: round-robin over your artists so one doesn't fill the row
  const playlists: SpPlaylistRef[] = []
  const seen = new Set<string>()
  for (let i = 0; i < 6; i++) {
    for (const p of pages) {
      const pl = p.playlists?.[i]
      if (pl && !seen.has(pl.uri)) {
        seen.add(pl.uri)
        playlists.push(pl)
      }
    }
  }

  // newest releases of your artists (last 18 months)
  const cutoff = new Date(Date.now() - 548 * 86400_000).toISOString().slice(0, 10)
  const rel = new Map<string, SpRelease>()
  for (const p of pages) {
    for (const r of [p.latest, ...p.albums.slice(0, 3), ...p.singles.slice(0, 3)]) {
      if (r?.date && r.date >= cutoff) rel.set(r.uri, { ...r, artists: r.artists.length ? r.artists : [p.name] })
    }
  }
  const releases = [...rel.values()].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).slice(0, 15)

  const home = { artists, playlists: playlists.slice(0, 15), releases }
  memo = { key, home }
  return home
}

let trackMemo: { key: string; tracks: SpTrack[] } | null = null

/** "Brani che potrebbero piacerti": the most played songs of the suggested
   artists (the best-voted first), a couple each, none already in your library */
export async function buildTracks(home: Home, songs: Song[]): Promise<SpTrack[]> {
  const picks = home.artists.slice(0, 8)
  const key = picks.map((a) => a.uri).join('|')
  if (trackMemo?.key === key) return trackMemo.tracks
  const known = knownArtists(songs)
  const titles = new Set(songs.map((s) => fold(s.title)))
  const pages = await Promise.all(picks.map((a) => engine.spArtist(a.uri).catch(() => null)))
  const out: SpTrack[] = []
  const seen = new Set<string>()
  for (let i = 0; i < 3; i++) {
    for (const p of pages) {
      const t = p?.topTracks[i]
      if (!t || seen.has(t.uri)) continue
      if (t.artists.some((a) => known.has(fold(a)))) continue
      if (titles.has(fold(`${t.artists[0]} - ${t.title}`))) continue
      seen.add(t.uri)
      out.push(t)
    }
  }
  const tracks = out.slice(0, 20)
  trackMemo = { key, tracks }
  return tracks
}

/* ------------------------------------------------------------- playlist suggestions */

/** "Titolo (Remastered 2011) - Live" → "titolo" */
const bare = (t: string) => fold(t.replace(/\s+[-–]\s+.*$/, '').replace(/\s*[([].*?[)\]]/g, ''))

/** a key for "the same song", whatever the source spelled it like */
export const trackKey = (artist: string, title: string) => `${fold(artist.split(/,| feat\.| ft\.| & /i)[0])}|${bare(title)}`

/** the songs already somewhere in your library, as trackKeys */
export const libraryKeys = (songs: Song[]) =>
  new Set(
    songs.map((s) => {
      const m = s.title.match(/^(.+?)\s+[–-]\s+(.+)$/)
      return m ? trackKey(m[1], m[2]) : `|${bare(s.title)}`
    })
  )

const poolMemo = new Map<string, SpTrack[]>()

/** songs like the ones of a playlist: the hits of its artists and of their
   similar artists, in a random order (the caller leaves out what you have) */
export async function playlistPool(list: Song[]): Promise<SpTrack[]> {
  const names = topArtists(list, 5)
  const key = names.join('|')
  if (!names.length) return []
  const hit = poolMemo.get(key)
  if (hit) return hit
  const seeds = (
    await Promise.all(
      names.map(async (n) => {
        const uri = await artistUri(n)
        return uri ? engine.spArtist(uri).catch(() => null) : null
      })
    )
  ).filter((a): a is NonNullable<typeof a> => !!a)
  const mine = new Set(names.map(fold))
  const votes = new Map<string, { a: SpArtistRef; n: number }>()
  seeds.forEach((p, rank) =>
    p.related.forEach((a, i) => {
      if (mine.has(fold(a.name))) return
      const v = votes.get(a.uri) ?? { a, n: 0 }
      v.n += 1 / (1 + i / 5) / (1 + rank / 4)
      votes.set(a.uri, v)
    })
  )
  const near = [...votes.values()].sort((x, y) => y.n - x.n).slice(0, 10)
  const rel = (await Promise.all(near.map((v) => engine.spArtist(v.a.uri).catch(() => null)))).filter((a): a is NonNullable<typeof a> => !!a)
  const seen = new Set<string>()
  const pool: SpTrack[] = []
  for (const t of [...seeds.flatMap((p) => p.topTracks.slice(0, 6)), ...rel.flatMap((p) => p.topTracks.slice(0, 5))]) {
    const k = trackKey(t.artists[0] ?? '', t.title)
    if (seen.has(t.uri) || seen.has(k)) continue
    seen.add(t.uri)
    seen.add(k)
    pool.push(t)
  }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  poolMemo.set(key, pool)
  return pool
}
