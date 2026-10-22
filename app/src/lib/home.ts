import { engine, type SpArtistRef, type SpPlaylistRef, type SpRelease } from './engine'
import { artistOf } from './media'
import type { Song } from './types'

/* The shelves of "Cerca", built from the artists you listen to most: their
   similar artists, the playlists they are in, their newest releases. */

export interface Home {
  artists: SpArtistRef[]
  playlists: SpPlaylistRef[]
  releases: SpRelease[]
}

const fold = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

/** your artists, most listened first: songs count, liked ones and recent plays weigh more */
export function topArtists(songs: Song[], n = 8): string[] {
  const score = new Map<string, { name: string; s: number }>()
  const now = Date.now()
  for (const s of songs) {
    const name = artistOf(s.title).split(/,| feat\.| ft\.| & /i)[0].trim()
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
  const key = names.join('|')
  if (memo?.key === key) return memo.home
  const mine = new Set(names.map(fold))
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
