import { ArrowLeft, ArrowUpLeft, Check, Clock, EllipsisVertical, MicVocal, Play, Plus, Search as SearchIcon, Share2, SlidersVertical, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { engine, type SpArtistRef, type SpPlaylistRef, type SpRelease, type SpSearch } from '../lib/engine'
import { isMatched, matchTrack, songFor, songsFor } from '../lib/catalog'
import { errMsg, fmtTime } from '../lib/format'
import type { YtResult } from '../lib/native'
import { useImports, type Import } from '../imports'
import { usePlayback } from '../playback'
import { useStore } from '../store'
import { Sheet, Spinner } from '../components/ui'
import { Shelf, TrackTiles, useOpenArtist, useSaver } from './Catalog'
import { SongMenu } from './Library'
import { NewEpisodes } from './Podcast'
import { podcastKey, podcastSearch, type Podcast } from '../lib/podcasts'
import { shareSpotify } from '../lib/share'
import { addRecent, clearRecents, loadRecents, removeRecent, type Recent } from '../lib/recents'
import { buildHome, buildTracks, cachedHome, saveHome, type Home } from '../lib/home'
import type { SpTrack } from '../lib/engine'
import type { Song } from '../lib/types'

const isLink = (q: string) => /^https?:\/\/|^spotify:/i.test(q)
const ytId = (q: string) => q.match(/(?:v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/)?.[1] ?? null
const isSpotifyList = (q: string) => /spotify\.com\/(?:intl-\w+\/)?(playlist|album)\/|spotify:(playlist|album):/i.test(q)

type Hit = Pick<YtResult, 'videoId' | 'title'> & Partial<YtResult>

export function Add() {
  const store = useStore()
  const imports = useImports()
  return (
    <div className="page flat">
      <Search />
      {imports.items.map((i) => (
        <SpotifyImport key={i.id} imp={i} />
      ))}
      {store.deviceJob && <SplitJob />}
    </div>
  )
}

/* ------------------------------------------------------------- search */

function Search() {
  const store = useStore()
  const playback = usePlayback()
  const imports = useImports()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ q: string; items: Hit[] } | null>(null)
  const [searching, setSearching] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const seq = useRef(0)
  // Spotify's three states: recommendations; focused (recent searches); typing (suggestions + results)
  const [focused, setFocused] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [recents, setRecents] = useState<Recent[]>(loadRecents)
  const input = useRef<HTMLInputElement>(null)
  const titleOf = (hit: Hit) => (hit.kind === 'song' && hit.channel ? `${hit.channel} – ${hit.title}` : hit.title)

  const songOf = (hit: Hit): Song =>
    store.getSong(`yt-${hit.videoId}`) ?? {
      id: `yt-${hit.videoId}`,
      title: titleOf(hit),
      duration: hit.duration ?? 0,
      stems: [],
      files: {},
      source: 'device',
      addedAt: Date.now()
    }

  // a YouTube link: play it
  const playLink = useCallback(
    (hit: Hit) => {
      const s = songOf(hit)
      store.addTemp([s])
      playback.playList([s.id], 0, 'Link YouTube')
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, playback]
  )

  const runSearch = useCallback(
    async (raw: string) => {
      const q = raw.trim()
      if (!q || !engine.available) return
      const my = ++seq.current
      setSearching(true)
      setErr(null)
      try {
        let text = q
        if (isLink(q)) {
          if (isSpotifyList(q)) {
            imports.add(q)
            setQuery('')
            return
          }
          const id = ytId(q)
          if (id && !/spotify/i.test(q)) {
            playLink({ videoId: id, title: 'Video YouTube' })
            setQuery('')
            return
          }
          text = await engine.spotifyQuery(q)
          setQuery(text)
        }
        const items = await engine.search(text)
        if (my === seq.current) {
          setResults({ q: text, items })
          engine.warm(items.slice(0, 4).map((x) => x.videoId), 1)
        }
      } catch (e) {
        if (my === seq.current) setErr(errMsg(e))
      } finally {
        if (my === seq.current) setSearching(false)
      }
    },
    [playLink, imports]
  )

  // results while typing (links wait for "Cerca")
  useEffect(() => {
    const q = query.trim()
    if (q.length < 3 || isLink(q)) return
    const t = setTimeout(() => void runSearch(q), 400)
    return () => clearTimeout(t)
  }, [query, runSearch])

  useEffect(() => {
    const q = query.trim()
    if (!focused || !q || isLink(q)) return setSuggestions([])
    let alive = true
    const t = setTimeout(() => {
      engine
        .suggest(q)
        .then((x) => alive && setSuggestions(x.slice(0, 5)))
        .catch(() => undefined)
    }, 120)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query, focused])

  const submit = (text: string) => {
    if (!isLink(text.trim())) addRecent({ kind: 'query', id: text.trim(), title: text.trim() })
    setQuery(text)
    setFocused(false)
    input.current?.blur()
    void runSearch(text)
    setRecents(loadRecents())
  }
  const exit = () => {
    setFocused(false)
    setQuery('')
    setResults(null)
    setSuggestions([])
    input.current?.blur()
  }
  const openRecent = (r: Recent) => {
    addRecent(r)
    setRecents(loadRecents())
    if (r.kind === 'query') return submit(r.id)
    if (r.kind === 'song') {
      const song = store.getSong(r.id) ?? { id: r.id, title: r.title, duration: 0, stems: [], files: {}, source: 'device' as const, addedAt: Date.now() }
      store.addTemp([song])
      setFocused(false)
      return playback.playList([song.id], 0, 'Recenti')
    }
    setFocused(false)
    store.openPage({ kind: r.kind, uri: r.id, name: r.title })
  }

  const job = store.deviceJob
  const status = (id: string): string | null => {
    const song = store.songs.find((s) => s.id === `yt-${id}`)
    if (job?.state === 'running' && job.songId === `yt-${id}`) return `separazione ${Math.round(job.pct)}%`
    if (job?.queue?.length && song && job.queue.includes(song.title)) return 'in coda'
    if (!song) return null
    return song.stems.length ? 'con tracce' : null
  }

  if (!engine.available) {
    return (
      <section className="card">
        <div className="notice">Apri l'app sul telefono o sul PC per cercare canzoni.</div>
      </section>
    )
  }

  const typing = focused && !!query.trim()
  return (
    <section className="card">
      <div className={`search ${focused ? 'focused' : ''}`}>
        {(focused || results) && (
          <button className="icon-btn" onClick={exit} aria-label="Indietro">
            <ArrowLeft />
          </button>
        )}
        <span className="search-field">
          {!focused && !results && <SearchIcon className="search-ico" />}
          <input
            ref={input}
            placeholder="Cosa vuoi ascoltare?"
            value={query}
            onFocus={() => (setFocused(true), setRecents(loadRecents()))}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && query.trim() && submit(query)}
            enterKeyHint="search"
            autoCapitalize="off"
            autoCorrect="off"
          />
          {query && (
            <button className="clear" onClick={() => (setQuery(''), input.current?.focus())} aria-label="Cancella">
              {searching ? <Spinner size={16} /> : <X />}
            </button>
          )}
        </span>
      </div>

      {!focused && !results && <HomeShelves />}

      {focused && !query.trim() && (
        <div className="recents">
          {recents.length > 0 && <h3 className="sec">Recenti</h3>}
          {recents.map((r) => (
            <div key={`${r.kind}:${r.id}`} className="recent-row">
              <button className="recent-main" onMouseDown={(e) => e.preventDefault()} onClick={() => openRecent(r)}>
                {r.kind === 'query' ? (
                  <span className="recent-ico">
                    <Clock />
                  </span>
                ) : r.image ? (
                  <img className={r.kind === 'artist' ? 'round' : ''} src={r.image} alt="" />
                ) : (
                  <span className="recent-ico">
                    <SearchIcon />
                  </span>
                )}
                <span className="lib-text">
                  <span className="row-title">{r.title}</span>
                  {r.sub && <span className="row-sub">{r.sub}</span>}
                </span>
              </button>
              <button className="icon-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => (removeRecent(r), setRecents(loadRecents()))} aria-label="Togli">
                <X />
              </button>
            </div>
          ))}
          {recents.length > 0 && (
            <button className="clear-recents" onMouseDown={(e) => e.preventDefault()} onClick={() => (clearRecents(), setRecents([]))}>
              Cancella ricerche recenti
            </button>
          )}
        </div>
      )}

      {typing && suggestions.length > 0 && (
        <div className="suggestions">
          {suggestions.map((x) => (
            <div key={x} className="sugg-row">
              <button className="sugg-main" onMouseDown={(e) => e.preventDefault()} onClick={() => submit(x)}>
                <SearchIcon /> {x}
              </button>
              <button className="icon-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => setQuery(x + ' ')} aria-label="Completa">
                <ArrowUpLeft />
              </button>
            </div>
          ))}
        </div>
      )}

      {(results || searching) && (typing || !focused) && (
        <MixedResults q={results?.q ?? ''} yt={results?.items ?? null} searching={searching} songOf={songOf} status={status} />
      )}
      {err && <div className="notice error">{err}</div>}
    </section>
  )
}

/* ------------------------------------------------------------- results, like Spotify */

type Mixed =
  | { kind: 'podcast'; p: Podcast }
  | { kind: 'track'; t: SpTrack }
  | { kind: 'yt'; hit: Hit }
  | { kind: 'artist' | 'album' | 'playlist'; x: SpArtistRef | SpRelease | SpPlaylistRef }

type SongItem = Extract<Mixed, { kind: 'track' | 'yt' }>
const isSongItem = (m: Mixed): m is SongItem => m.kind === 'track' || m.kind === 'yt'
const keyOf = (m: Mixed) => (m.kind === 'yt' ? `yt:${m.hit.videoId}` : m.kind === 'track' ? m.t.uri : m.kind === 'podcast' ? `pod:${m.p.feed}` : m.x.uri)
const bare = (t: string) =>
  t
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?]|official|video|audio|lyrics?|testo/g, '')
    .replace(/[^a-z0-9]+/g, '')

/** one list in order of relevance, like Spotify: its top results (any kind), then mostly songs
   with an artist, an album or a playlist every few, then what only YouTube has */
function mixResults(sp: SpSearch | null, yt: Hit[], pods: Podcast[], q: string): Mixed[] {
  const out: Mixed[] = []
  const seen = new Set<string>()
  const push = (m: Mixed) => {
    const k = keyOf(m)
    if (seen.has(k)) return
    seen.add(k)
    out.push(m)
  }
  for (const x of sp?.top ?? []) push(x.kind === 'track' ? { kind: 'track', t: x } : ({ kind: x.kind, x } as Mixed))
  if (sp) {
    const queues = {
      track: [...sp.tracks],
      artist: sp.artists.slice(0, 4),
      album: sp.albums.slice(0, 5),
      playlist: (sp.playlists ?? []).slice(0, 4)
    }
    const pattern = ['track', 'track', 'artist', 'track', 'album', 'track', 'playlist'] as const
    while (Object.values(queues).some((q) => q.length)) {
      for (const k of pattern) {
        const v = queues[k].shift()
        if (v) push(k === 'track' ? { kind: 'track', t: v as SpTrack } : { kind: k, x: v as SpArtistRef })
      }
    }
  }
  const titles = new Set(out.flatMap((m) => (m.kind === 'track' ? [bare(m.t.title)] : [])))
  for (const h of yt) if (!titles.has(bare(h.title))) push({ kind: 'yt', hit: h })
  // podcasts: right after the best result when the name says what you typed, else further down
  const want = bare(q)
  let strong = 1
  pods.slice(0, 3).forEach((p, i) => {
    const hit = want.length > 2 && (bare(p.name).includes(want) || bare(p.author).includes(want))
    const at = hit ? Math.min(out.length, strong++) : Math.min(out.length, 8 + i * 4)
    if (!seen.has(`pod:${p.feed}`)) {
      seen.add(`pod:${p.feed}`)
      out.splice(at, 0, { kind: 'podcast', p })
    }
  })
  return out
}

function MixedResults({
  q,
  yt,
  searching,
  songOf,
  status
}: {
  q: string
  yt: Hit[] | null
  searching: boolean
  songOf: (hit: Hit) => Song
  status: (videoId: string) => string | null
}) {
  const store = useStore()
  const playback = usePlayback()
  const [sp, setSp] = useState<SpSearch | null>(null)
  const [pods, setPods] = useState<Podcast[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setSp(null)
    setPods([])
    if (q.trim().length < 2) return
    podcastSearch(q)
      .then((x) => alive && setPods(x))
      .catch(() => undefined)
    engine
      .spSearch(q)
      .then((x) => {
        if (!alive) return
        setSp(x)
        // the songs are looked up on YouTube in the background: tapping is then instant
        void songsFor([...(x.top ?? []).filter((t) => t.kind === 'track'), ...x.tracks].slice(0, 12) as SpTrack[], store.getSong)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])
  const items = mixResults(sp, yt ?? [], pods, q)

  /** a song of the results as a song of the app (its YouTube match); null if it has none */
  const resolve = async (m: Mixed): Promise<Song | null> => {
    if (m.kind === 'yt') return songOf(m.hit)
    if (m.kind !== 'track') return null
    const vid = await matchTrack(m.t)
    return vid ? store.getSong(`yt-${vid}`) ?? songFor(m.t, vid) : null
  }
  /** tap on a song: it plays, then the other songs of the results (those already found) */
  const play = async (m: Mixed) => {
    const k = keyOf(m)
    setBusy(k)
    try {
      const songItems = items.filter(isSongItem)
      const list = await Promise.all(songItems.map((x) => (x === m || x.kind === 'yt' || (x.kind === 'track' && isMatched(x.t)) ? resolve(x) : null)))
      const at = songItems.indexOf(m as SongItem)
      const mine = list[at]
      if (!mine) return store.showToast('Non trovata su YouTube')
      const songs = list.filter((s): s is Song => !!s)
      store.addTemp(songs)
      addRecent(
        m.kind === 'track'
          ? { kind: 'song', id: mine.id, title: mine.title, sub: 'Brano', image: m.t.image }
          : { kind: 'song', id: mine.id, title: mine.title, sub: 'Brano', image: m.kind === 'yt' ? m.hit.thumbnail : undefined }
      )
      playback.playList(
        songs.map((s) => s.id),
        Math.max(0, songs.indexOf(mine)),
        `Ricerca “${q}”`
      )
    } finally {
      setBusy(null)
    }
  }
  // ⋮ of a song: the same menu as everywhere (the song is looked up on YouTube first)
  const [menuSong, setMenuSong] = useState<Song | null>(null)
  const [menuOf, setMenuOf] = useState<Mixed | null>(null)
  const openMenu = async (m: Mixed) => {
    if (!isSongItem(m)) return setMenuOf(m)
    const k = keyOf(m)
    setBusy(k)
    try {
      const s = await resolve(m)
      if (!s) return store.showToast('Non trovata su YouTube')
      store.addTemp([s])
      setMenuSong(s)
    } finally {
      setBusy(null)
    }
  }

  if (!items.length)
    return searching ? (
      <div className="page-loading">
        <Spinner size={26} />
      </div>
    ) : yt ? (
      <p className="muted pad">Nessun risultato.</p>
    ) : null

  return (
    <div className="results mixed">
      {items.map((m) => {
        const k = keyOf(m)
        if (m.kind === 'podcast') {
          const p = m.p
          const key = podcastKey(p.feed)
          const on = store.isFollowing(key)
          return (
            <div key={k} className="result">
              <button className="result-main" onClick={() => store.openPage({ kind: 'podcast', uri: p.feed, name: p.name })}>
                <span className="result-thumb">{p.image ? <img src={p.image} alt="" loading="lazy" /> : null}</span>
                <span className="result-text">
                  <span className="result-title">{p.name}</span>
                  <span className="row-sub">Podcast · {p.author}</span>
                </span>
              </button>
              <button
                className={`r-act ${on ? 'on' : ''}`}
                onClick={() => {
                  store.toggleFollow({ uri: key, name: p.name, image: p.image })
                  store.showToast(on ? `Non segui più ${p.name}` : `Ora segui ${p.name}`)
                }}
              >
                {on ? <Check /> : <Plus />}
                <small>{on ? 'Segui già' : 'Segui'}</small>
              </button>
            </div>
          )
        }
        if (!isSongItem(m)) {
          const x = m.x
          const sub =
            m.kind === 'artist'
              ? 'Artista'
              : m.kind === 'album'
                ? `Album · ${(x as SpRelease).artists.join(', ')}`
                : `Playlist${(x as SpPlaylistRef).owner ? ` · ${(x as SpPlaylistRef).owner}` : ''}`
          return (
            <div key={k} className="result">
              <button
                className="result-main"
                onClick={() => {
                  addRecent({ kind: m.kind, id: x.uri, title: x.name, sub, image: x.image })
                  store.openPage({ kind: m.kind, uri: x.uri, name: x.name })
                }}
              >
                <span className={`result-thumb ${m.kind === 'artist' ? 'round' : ''}`}>{x.image ? <img src={x.image} alt="" loading="lazy" /> : null}</span>
                <span className="result-text">
                  <span className="result-title">{x.name}</span>
                  <span className="row-sub">{sub}</span>
                </span>
              </button>
              {m.kind === 'artist' && (
                <button
                  className={`r-act ${store.isFollowing(x.uri) ? 'on' : ''}`}
                  onClick={() => {
                    const on = store.isFollowing(x.uri)
                    store.toggleFollow(x)
                    store.showToast(on ? `Non segui più ${x.name}` : `Ora segui ${x.name}`)
                  }}
                  aria-label={store.isFollowing(x.uri) ? `Non seguire più ${x.name}` : `Segui ${x.name}`}
                >
                  {store.isFollowing(x.uri) ? <Check /> : <Plus />}
                  <small>{store.isFollowing(x.uri) ? 'Segui già' : 'Segui'}</small>
                </button>
              )}
              {m.kind !== 'artist' && (
                <button className="icon-btn" onClick={() => void openMenu(m)} aria-label={`Opzioni ${x.name}`}>
                  <EllipsisVertical />
                </button>
              )}
            </div>
          )
        }
        const vid = m.kind === 'yt' ? m.hit.videoId : null
        const song = vid ? store.songs.find((s) => s.id === `yt-${vid}`) : m.kind === 'track' ? store.songs.find((s) => s.spotifyUri === m.t.uri) : undefined
        const current = !!song && playback.now?.songId === song.id
        const st = vid ? status(vid) : null
        const title = m.kind === 'yt' ? m.hit.title : m.t.title
        const sub =
          m.kind === 'yt'
            ? `Video · ${m.hit.channel ?? ''}${m.hit.duration ? ` · ${fmtTime(m.hit.duration)}` : ''}`
            : `Brano · ${m.t.artists.join(', ')}`
        const image = m.kind === 'yt' ? m.hit.thumbnail || `https://i.ytimg.com/vi/${m.hit.videoId}/mqdefault.jpg` : m.t.image
        return (
          <div key={k} className={`result ${current ? 'current' : ''}`}>
            <button className="result-main" onClick={() => void play(m)}>
              <span className="result-thumb">
                {image ? <img src={image} alt="" loading="lazy" /> : null}
                {(busy === k || (current && playback.loading)) && (
                  <span className="thumb-busy">
                    <Spinner size={22} />
                  </span>
                )}
              </span>
              <span className="result-text">
                <span className="result-title">{title}</span>
                <span className="row-sub">
                  {sub}
                  {st && <span className="tag">{st}</span>}
                </span>
              </span>
            </button>
            {song && <Check className="in-lib-mark" aria-label="In libreria" />}
            <button className="icon-btn" onClick={() => void openMenu(m)} aria-label={`Opzioni ${title}`}>
              <EllipsisVertical />
            </button>
          </div>
        )
      })}
      {menuSong && <SongMenu song={store.getSong(menuSong.id) ?? menuSong} index={0} playlist={null} onClose={() => setMenuSong(null)} />}
      {menuOf && !isSongItem(menuOf) && menuOf.kind !== 'podcast' && <CollectionMenu m={menuOf} onClose={() => setMenuOf(null)} />}
    </div>
  )
}

/** ⋮ of an album or a playlist in the results: share, save in the library, its artists */
function CollectionMenu({ m, onClose }: { m: Extract<Mixed, { kind: 'album' | 'playlist' | 'artist' }>; onClose: () => void }) {
  const store = useStore()
  const openArtist = useOpenArtist()
  const { save } = useSaver()
  const x = m.x
  const [tracks, setTracks] = useState<SpTrack[] | null>(null)
  const [picking, setPicking] = useState(false)
  useEffect(() => {
    let alive = true
    const load =
      m.kind === 'album'
        ? engine.spAlbum(x.uri).then((a) => a.tracks)
        : engine.spPlaylist(x.uri).then((p) =>
            p.tracks.map((t) => ({
              uri: t.uri || `x:${t.artist}|${t.title}`,
              title: t.title,
              artists: t.artist.split(', ').filter(Boolean),
              artistUris: t.artistUri ? [t.artistUri] : [],
              duration: t.duration,
              image: t.image || p.image
            }))
          )
    load.then((t) => alive && setTracks(t)).catch(() => alive && setTracks([]))
    return () => {
      alive = false
    }
  }, [m.kind, x.uri])
  // its artists, the most present first (an album: its own; a playlist: the ones it has most)
  const artists = (() => {
    const count = new Map<string, { name: string; uri?: string; n: number }>()
    for (const t of tracks ?? []) {
      t.artists.forEach((name, i) => {
        const c = count.get(name) ?? { name, uri: t.artistUris[i], n: 0 }
        c.n++
        c.uri ??= t.artistUris[i]
        count.set(name, c)
      })
    }
    return [...count.values()].sort((a, b) => b.n - a.n).slice(0, 8)
  })()
  const saved = store.playlists.some((p) => p.source === x.uri)
  if (picking)
    return (
      <Sheet title="Vai agli artisti" onClose={onClose}>
        {artists.map((a) => (
          <button key={a.name} onClick={() => (void openArtist({ title: '' }, a), onClose())}>
            <MicVocal /> {a.name}
          </button>
        ))}
      </Sheet>
    )
  return (
    <Sheet title={x.name} onClose={onClose}>
      <button onClick={() => (onClose(), void shareSpotify(x.name, x.uri).then((r) => r === 'copied' && store.showToast('Link copiato')))}>
        <Share2 /> Condividi
      </button>
      <button
        disabled={saved || !tracks?.length}
        onClick={() => {
          if (tracks) void save(x.name, x.uri, tracks, false)
          store.showToast(`Aggiungo “${x.name}” alla libreria…`)
          onClose()
        }}
      >
        {saved ? <Check /> : <Plus />} {saved ? 'Già in libreria' : 'Aggiungi alla libreria'}
      </button>
      {!tracks ? (
        <button disabled>
          <Spinner size={14} /> Artisti…
        </button>
      ) : artists.length > 1 ? (
        <button onClick={() => setPicking(true)}>
          <MicVocal /> Vai agli artisti
        </button>
      ) : artists.length === 1 ? (
        <button onClick={() => (void openArtist({ title: '' }, artists[0]), onClose())}>
          <MicVocal /> Vai all'artista
        </button>
      ) : null}
    </Sheet>
  )
}

/* ------------------------------------------------------------- Spotify import */

function SpotifyImport({ imp }: { imp: Import }) {
  const imports = useImports()
  const [split, setSplit] = useState(false)
  const [download, setDownload] = useState(false)
  const { list, states, phase } = imp
  const count = (st: string) => states.filter((x) => x === st).length
  const finished = count('fatto') + count('già presente') + count('non trovata')
  return (
    <section className="card import">
      <div className="card-head">
        <h2>{list ? list.name : 'Playlist Spotify'}</h2>
        {phase !== 'running' && (
          <button className="icon-btn" onClick={() => imports.remove(imp.id)} aria-label="Chiudi">
            <X />
          </button>
        )}
      </div>
      {phase === 'loading' && (
        <div className="page-loading">
          <Spinner size={26} />
        </div>
      )}
      {imp.error && <div className="notice error">{imp.error}</div>}
      {list && phase === 'ready' && (
        <>
          <label className="switch-row">
            <input type="checkbox" checked={download} onChange={(e) => setDownload(e.target.checked)} />
            <span>Scarica anche sul dispositivo</span>
          </label>
          <label className="switch-row">
            <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} />
            <span>Separa anche le tracce</span>
          </label>
          <button className="primary" onClick={() => imports.start(imp.id, { download, split })}>
            Importa {list.tracks.length} brani
          </button>
        </>
      )}
      {list && (phase === 'running' || phase === 'done') && (
        <>
          <div className="bar">
            <i style={{ width: `${(finished / list.tracks.length) * 100}%` }} />
          </div>
          <p className="muted small">
            {finished}/{list.tracks.length}
            {count('non trovata') ? ` · non trovati ${count('non trovata')}` : ''}
          </p>
          {phase === 'running' && (
            <button className="small" onClick={() => imports.stop(imp.id)}>
              Interrompi
            </button>
          )}
        </>
      )}
      {list && (
        <div className="import-list">
          {list.tracks.map((t, i) => (
            <div key={i} className={`import-row ${states[i]?.replace(/\s/g, '-')}`}>
              <span className="pick-title">
                {t.title} <span className="muted">· {t.artist}</span>
              </span>
              <span className="tag">{states[i]}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/* ------------------------------------------------------------- split in progress */

function SplitJob() {
  const store = useStore()
  const playback = usePlayback()
  const job = store.deviceJob!
  const running = job.state === 'running'
  const queue = job.queue ?? []
  return (
    <section className="card">
      <div className={`job ${job.state}`}>
        <div className="job-title">
          <SlidersVertical /> {job.title ?? 'Canzone'}
        </div>
        <div className="bar">
          <i style={{ width: `${job.pct}%` }} />
        </div>
        <div className="job-msg">
          {job.state === 'failed' ? job.error || job.message : job.message} {running ? `${Math.round(job.pct)}%` : ''}
        </div>
        {queue.length > 0 && (
          <div className="job-msg">
            In coda ({queue.length}): {queue.join(' · ')}
          </div>
        )}
        <div className="row-actions">
          {running ? (
            <>
              <button className="small" onClick={() => void engine.cancelSeparation()}>
                Annulla
              </button>
              {queue.length > 0 && (
                <button className="small" onClick={() => void engine.cancelSeparation(true)}>
                  Annulla tutto
                </button>
              )}
            </>
          ) : (
            <>
              {job.state === 'done' && (
                <button className="small primary" onClick={() => playback.playSong(job.songId)}>
                  <Play fill="currentColor" /> Play
                </button>
              )}
              <button className="small" onClick={() => store.setDeviceJob(null)}>
                OK
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------- recommendations */

function HomeShelves() {
  const store = useStore()
  // built once a day: until tomorrow the same shelves come back at once
  const [day] = useState(cachedHome)
  const [home, setHome] = useState<Home | null>(day?.home ?? null)
  const [tracks, setTracks] = useState<SpTrack[]>(day?.tracks ?? [])
  const [failed, setFailed] = useState(false)
  const empty = !store.songs.length
  useEffect(() => {
    if (day) return
    let alive = true
    buildHome(
      store.songs,
      store.artists.map((a) => a.name)
    )
      .then((h) => {
        if (!alive) return
        setHome(h)
        // the songs need one more page per artist: they come in after the rest
        void buildTracks(h, store.songs).then(
          (t) => {
            if (alive) setTracks(t)
            if (h.artists.length) saveHome(h, t)
          },
          () => undefined
        )
      })
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empty])
  if (failed) return null
  if (!home)
    return (
      <div className="page-loading">
        <Spinner size={26} />
      </div>
    )
  return (
    <div className="home-shelves">
      <Shelf title="Artisti che potrebbero piacerti" items={home.artists} round />
      <TrackTiles title="Brani che potrebbero piacerti" tracks={tracks} />
      <Shelf title="Playlist da ascoltare" items={home.playlists} />
      <Shelf title="Ultime uscite dei tuoi artisti" items={home.releases} showArtist />
      <NewEpisodes />
    </div>
  )
}
