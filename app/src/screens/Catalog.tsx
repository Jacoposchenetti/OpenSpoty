import { Check, ChevronLeft, RefreshCw, Download, Play, Plus, Shuffle, Share2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Spinner, useBackHandler } from '../components/ui'
import { isMatched, matchTrack, songsFor } from '../lib/catalog'
import { engine, type SpAlbum, type SpArtist, type SpArtistRef, type SpPlaylistRef, type SpRelease, type SpTrack, type SpotifyList } from '../lib/engine'
import { addRecent } from '../lib/recents'
import { errMsg, fmtTime } from '../lib/format'
import { shareSpotify } from '../lib/share'
import { artistOf, nameParts } from '../lib/media'
import type { Playlist, Song } from '../lib/types'
import { libraryKeys, playlistPool, trackKey } from '../lib/home'
import { PlaylistPicker } from './Library'
import { usePlayback } from '../playback'
import { useStore, type Page } from '../store'

/* Spotify-like artist and album pages: names and artwork from Spotify, audio
   streamed from YouTube (lib/catalog.ts finds the same recording). */

export function CatalogPage({ page }: { page: Page }) {
  const store = useStore()
  useBackHandler(store.closePage)
  if (page.kind === 'artist') return <ArtistPage key={page.uri} uri={page.uri} />
  if (page.kind === 'playlist') return <PlaylistPage key={page.uri} uri={page.uri} />
  return <AlbumPage key={page.uri} uri={page.uri} />
}

/** "Vai all'artista" from a song of the library: its Spotify artist, or a search by name */
export function useOpenArtist() {
  const store = useStore()
  return async (song: { title: string; artistUri?: string }) => {
    if (song.artistUri) return store.openPage({ kind: 'artist', uri: song.artistUri })
    const name = artistOf(song.title)
    if (!name) return store.showToast('Artista sconosciuto')
    try {
      const r = await engine.spSearch(name)
      const fold = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      const a = r.artists.find((x) => fold(x.name) === fold(name)) ?? r.artists[0]
      if (a) store.openPage({ kind: 'artist', uri: a.uri, name: a.name })
      else store.showToast(`“${name}” non trovato`)
    } catch (e) {
      store.showToast(errMsg(e))
    }
  }
}

/**
 * "Vai all'album": known for songs that came from Spotify; for the others
 * (YouTube, imports) the track is looked up on Spotify by title and artist,
 * and the album remembered on the song.
 */
export function useOpenAlbum() {
  const store = useStore()
  return async (song: Song) => {
    if (song.albumUri) return store.openPage({ kind: 'album', uri: song.albumUri })
    const { name, artist } = nameParts(song.title)
    const fold = (t: string) =>
      t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\(.*?\)|\[.*?]|- .*remaster.*$/g, '').replace(/[^a-z0-9 ]/g, ' ').trim()
    try {
      const r = await engine.spSearch(artist ? `${artist} ${name}` : name)
      const want = fold(name)
      const t =
        r.tracks.find((x) => x.albumUri && fold(x.title).includes(want) && (!artist || x.artists.some((a) => fold(a) === fold(artist)))) ??
        r.tracks.find((x) => x.albumUri && fold(x.title).includes(want)) ??
        r.tracks.find((x) => x.albumUri)
      if (!t?.albumUri) return store.showToast('Album non trovato')
      if (store.songs.some((s) => s.id === song.id)) store.updateSong(song.id, { albumUri: t.albumUri, spotifyUri: song.spotifyUri ?? t.uri })
      store.openPage({ kind: 'album', uri: t.albumUri, name: t.album })
    } catch (e) {
      store.showToast(errMsg(e))
    }
  }
}

/** plays (and pre-matches) a list of Spotify tracks */
function useTrackPlayer(tracks: SpTrack[], name: string) {
  const store = useStore()
  const pb = usePlayback()
  const [busy, setBusy] = useState<string | null>(null)
  const [, bump] = useState(0)
  // look the tracks up in the background: tapping is then instant
  useEffect(() => {
    let alive = true
    void songsFor(tracks, store.getSong).then((songs) => {
      if (!alive) return
      bump((x) => x + 1)
      engine.warm(songs.slice(0, 4).flatMap((s) => (s.id.startsWith('yt-') ? [s.id.slice(3)] : [])), 1)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks])
  const play = async (index: number, shuffle = false) => {
    setBusy(tracks[index]?.uri ?? 'all')
    try {
      const songs = await songsFor(tracks, store.getSong)
      if (!songs.length) return store.showToast('Nessuno di questi brani trovato su YouTube')
      store.addTemp(songs)
      const vid = await matchTrack(tracks[index])
      let start = Math.max(0, songs.findIndex((s) => s.id === `yt-${vid}`))
      let ids = songs.map((s) => s.id)
      if (shuffle) {
        ids = [...ids].sort(() => Math.random() - 0.5)
        start = 0
      }
      pb.playList(ids, start, name)
    } finally {
      setBusy(null)
    }
  }
  return { play, busy }
}

function TrackRow({ t, i, onPlay, busy, showArt, onAdd }: { t: SpTrack; i: number; onPlay: () => void; busy: boolean; showArt?: boolean; onAdd?: (song: Song) => void }) {
  const store = useStore()
  const pb = usePlayback()
  const [vid, setVid] = useState<string | null>(null)
  useEffect(() => {
    if (isMatched(t)) void matchTrack(t).then(setVid)
  }, [t])
  const id = vid ? `yt-${vid}` : null
  const inLib = id ? store.songs.some((s) => s.id === id) : false
  const current = id && pb.now?.songId === id
  const add = async () => {
    const v = vid ?? (await matchTrack(t))
    if (!v) return store.showToast('Non trovata su YouTube')
    setVid(v)
    const [song] = await songsFor([t], store.getSong)
    if (!song) return
    if (onAdd) onAdd(song)
    else store.addToLibrary(song)
  }
  return (
    <div className={`song-row ${current ? 'current' : ''}`}>
      <button className="song-main" onClick={onPlay}>
        {busy ? (
          <span className="track-n">
            <Spinner />
          </span>
        ) : showArt ? (
          <img className="thumb" src={t.image} alt="" style={{ width: 44, height: 44 }} loading="lazy" />
        ) : (
          <span className="track-n">{i + 1}</span>
        )}
        <span className="lib-text">
          <span className="row-title">{t.title}</span>
          <span className="row-sub">
            {t.artists.join(', ')}
            {t.duration ? ` · ${fmtTime(t.duration)}` : ''}
          </span>
        </span>
      </button>
      <button className={`icon-btn ${inLib ? 'in-lib' : ''}`} onClick={() => void add()} aria-label={inLib ? 'Nella libreria' : 'Aggiungi alla libreria'} disabled={inLib}>
        {inLib ? <Check /> : <Plus />}
      </button>
    </div>
  )
}

/** "Brani consigliati" under a playlist: six songs like its own that you don't
   have anywhere, "Aggiorna" brings six more; + adds one to the playlist */
export function PlaylistSuggestions({ playlist }: { playlist: Playlist }) {
  const store = useStore()
  const [pool, setPool] = useState<SpTrack[] | null>(null)
  const [page, setPage] = useState(0)
  const ids = playlist.songIds.join(',')
  const list = useMemo(() => {
    const byId = new Map(store.songs.map((s) => [s.id, s]))
    return playlist.songIds.flatMap((id) => byId.get(id) ?? [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids])
  useEffect(() => {
    let alive = true
    setPool(null)
    playlistPool(list)
      .then((p) => alive && setPool(p))
      .catch(() => alive && setPool([]))
    return () => {
      alive = false
    }
  }, [list])
  const have = useMemo(() => libraryKeys(store.songs), [store.songs])
  const fresh = useMemo(() => (pool ?? []).filter((t) => !have.has(trackKey(t.artists[0] ?? '', t.title))), [pool, have])
  const pages = Math.max(1, Math.ceil(fresh.length / 6))
  const shown = useMemo(() => fresh.slice((page % pages) * 6, (page % pages) * 6 + 6), [fresh, page, pages])
  const tp = useTrackPlayer(shown, 'Brani consigliati')
  if (pool && !fresh.length) return null
  return (
    <section className="suggestions">
      <h3>Brani consigliati</h3>
      <p className="muted small">In base ai brani di questa playlist</p>
      {!pool ? (
        <div className="page-loading">
          <Spinner size={22} />
        </div>
      ) : (
        shown.map((t, i) => (
          <TrackRow
            key={t.uri}
            t={t}
            i={i}
            showArt
            busy={tp.busy === t.uri}
            onPlay={() => void tp.play(i)}
            onAdd={(song) => {
              store.addToLibrary(song, true)
              store.addToPlaylist(playlist.id, [song.id])
              store.showToast(`Aggiunta a ${playlist.name}`)
            }}
          />
        ))
      )}
      {pool && fresh.length > 6 && (
        <button className="refresh" onClick={() => setPage(page + 1)}>
          <RefreshCw /> Aggiorna
        </button>
      )}
    </section>
  )
}

/** a row of songs with their covers to scroll sideways (the shelves of
   "Cerca"): tap = listen, + = pick a playlist to save it in */
export function TrackTiles({ title, tracks }: { title: string; tracks: SpTrack[] }) {
  const store = useStore()
  const have = useMemo(() => libraryKeys(store.songs), [store.songs])
  const shown = useMemo(() => tracks.filter((t) => !have.has(trackKey(t.artists[0] ?? '', t.title))), [tracks, have])
  const tp = useTrackPlayer(shown, title)
  const [picking, setPicking] = useState<SpTrack | null>(null)
  const save = async (t: SpTrack, pid: string, pname: string) => {
    const vid = await matchTrack(t)
    if (!vid) return store.showToast('Non trovata su YouTube')
    const [song] = await songsFor([t], store.getSong)
    if (!song) return
    store.addToLibrary(song, true)
    const n = store.addToPlaylist(pid, [song.id])
    store.showToast(n ? `Aggiunta a “${pname}”` : `È già in “${pname}”`)
  }
  if (!shown.length) return null
  return (
    <section className="shelf">
      <h3>{title}</h3>
      <div className="shelf-row">
        {shown.map((t, i) => (
          <div key={t.uri} className="track-tile">
            <button className="card-tile" onClick={() => void tp.play(i)}>
              {t.image ? <img src={t.image} alt="" loading="lazy" /> : <span className="tile-ph" />}
              {tp.busy === t.uri && (
                <span className="tile-busy">
                  <Spinner size={26} />
                </span>
              )}
              <span className="tile-title">{t.title}</span>
              <span className="tile-sub">{t.artists.join(', ')}</span>
            </button>
            <button className="tile-add" onClick={() => setPicking(t)} aria-label={`Aggiungi ${t.title} a una playlist`}>
              <Plus />
            </button>
          </div>
        ))}
      </div>
      {picking && (
        <PlaylistPicker
          title="Aggiungi a playlist"
          onClose={() => setPicking(null)}
          onPick={(pid, pname) => void save(picking, pid, pname)}
        />
      )}
    </section>
  )
}

type Tile = SpRelease | SpArtistRef | SpPlaylistRef
const kindOf = (uri: string) => (uri.startsWith('spotify:artist') ? 'artist' : uri.startsWith('spotify:playlist') ? 'playlist' : 'album')

/** a row of cards to scroll sideways: artists (round), albums and playlists */
export function Shelf({ title, items, round, showArtist, recent }: { title: string; items: Tile[]; round?: boolean; showArtist?: boolean; recent?: boolean }) {
  const store = useStore()
  if (!items.length) return null
  return (
    <section className="shelf">
      <h3>{title}</h3>
      <div className="shelf-row">
        {items.map((x) => {
          const kind = kindOf(x.uri)
          const rel = 'type' in x ? x : null
          const pl = kind === 'playlist' ? (x as SpPlaylistRef) : null
          const sub = rel
            ? [showArtist ? rel.artists[0] : rel.year, kindLabel(rel.type)].filter(Boolean).join(' · ')
            : pl
              ? pl.owner === 'Spotify' ? pl.description || 'Playlist' : `Playlist${pl.owner ? ` · ${pl.owner}` : ''}`
              : 'Artista'
          return (
            <button
              key={x.uri}
              className={`card-tile ${round || kind === 'artist' ? 'round' : ''}`}
              onClick={() => {
                if (recent) addRecent({ kind, id: x.uri, title: x.name, sub, image: x.image })
                store.openPage({ kind, uri: x.uri, name: x.name })
              }}
            >
              {x.image ? <img src={x.image} alt="" loading="lazy" /> : <span className="tile-ph" />}
              <span className="tile-title">{x.name}</span>
              <span className="tile-sub">{sub}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

const kindLabel = (t: string) => ({ ALBUM: 'Album', SINGLE: 'Singolo', EP: 'EP', COMPILATION: 'Raccolta' })[t] ?? ''

function PageTop({ title }: { title: string }) {
  const store = useStore()
  return (
    <div className="list-top">
      <button className="icon-btn back" onClick={store.closePage} aria-label="Indietro">
        <ChevronLeft />
      </button>
      <div className="list-title">
        <h1>{title}</h1>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- artist */

/** "Segui" / "Segui già", like Spotify */
function FollowButton({ a }: { a: SpArtistRef }) {
  const store = useStore()
  const on = store.isFollowing(a.uri)
  return (
    <button
      className={`follow-btn ${on ? 'on' : ''}`}
      onClick={() => {
        store.toggleFollow(a)
        store.showToast(on ? `Non segui più ${a.name}` : `Ora segui ${a.name}`)
      }}
    >
      {on ? 'Segui già' : 'Segui'}
    </button>
  )
}

function ArtistPage({ uri }: { uri: string }) {
  const [a, setA] = useState<SpArtist | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const [disc, setDisc] = useState<'albums' | 'singles' | 'compilations'>('albums')
  const [bio, setBio] = useState(false)
  useEffect(() => {
    engine
      .spArtist(uri)
      .then(setA)
      .catch((e) => setErr(errMsg(e)))
  }, [uri])
  const top = useMemo(() => a?.topTracks ?? [], [a])
  const tp = useTrackPlayer(top, a?.name ?? 'Artista')

  if (err) return <Failed title="Artista" err={err} />
  if (!a) return <Loading title="Artista" />
  return (
    <div className="lib catalog">
      <PageTop title="" />
      <div className="artist-hero" style={{ backgroundImage: `url(${a.header || a.image})` }}>
        <div className="artist-hero-text">
          <h1>{a.name}</h1>
          {a.listeners ? <span>{a.listeners.toLocaleString('it-IT')} ascoltatori mensili</span> : null}
        </div>
      </div>
      <div className="list-actions">
        <button className="primary" disabled={!top.length || !!tp.busy} onClick={() => void tp.play(0)}>
          {tp.busy ? <Spinner /> : <Play fill="currentColor" />} Riproduci
        </button>
        <button disabled={top.length < 2 || !!tp.busy} onClick={() => void tp.play(0, true)}>
          <Shuffle /> Casuale
        </button>
        <button className="share-btn" onClick={() => void shareSpotify(a.name, a.uri)} aria-label="Condividi">
          <Share2 />
        </button>
      </div>
      <FollowButton a={a} />
      <h3 className="sec">Popolari</h3>
      {(more ? top : top.slice(0, 5)).map((t, i) => (
        <TrackRow key={t.uri} t={t} i={i} showArt busy={tp.busy === t.uri} onPlay={() => void tp.play(i)} />
      ))}
      {top.length > 5 && (
        <button className="link-btn" onClick={() => setMore(!more)}>
          {more ? 'Mostra meno' : 'Mostra altro'}
        </button>
      )}
      <h3 className="sec">Discografia</h3>
      <div className="chips">
        {(['albums', 'singles', 'compilations'] as const)
          .filter((k) => a[k].length)
          .map((k) => (
            <button key={k} className={disc === k ? 'active' : ''} onClick={() => setDisc(k)}>
              {k === 'albums' ? 'Album' : k === 'singles' ? 'Singoli ed EP' : 'Raccolte'}
            </button>
          ))}
      </div>
      <Shelf title="" items={a[disc]} />
      <Shelf title="Fan anche di" items={a.related} round />
      <Shelf title="Appare in" items={a.appearsOn ?? []} />
      {a.bio && (
        <section className="bio" onClick={() => setBio(!bio)}>
          <h3>Informazioni</h3>
          <p className={bio ? '' : 'clamp'}>{a.bio}</p>
        </section>
      )}
    </div>
  )
}

/* ------------------------------------------------------------- album */

function AlbumPage({ uri }: { uri: string }) {
  const store = useStore()
  const [al, setAl] = useState<SpAlbum | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    engine
      .spAlbum(uri)
      .then(setAl)
      .catch((e) => setErr(errMsg(e)))
  }, [uri])
  const tracks = useMemo(() => al?.tracks ?? [], [al])
  const tp = useTrackPlayer(tracks, al?.name ?? 'Album')

  const { saving, save: saveAs } = useSaver()
  const save = (andDownload: boolean) => al && void saveAs(al.name, al.uri, tracks, andDownload)

  if (err) return <Failed title="Album" err={err} />
  if (!al) return <Loading title="Album" />
  const artistUri = tracks[0]?.artistUris[0]
  return (
    <div className="lib catalog">
      <PageTop title="" />
      <div className="album-hero">
        <img src={al.image} alt="" />
        <h1>{al.name}</h1>
        <button
          className="link-btn"
          onClick={() => artistUri && store.openPage({ kind: 'artist', uri: artistUri, name: al.artists[0] })}
          disabled={!artistUri}
        >
          {al.artists.join(', ')}
        </button>
        <span className="muted small">
          {[kindLabel(al.type), al.year, `${tracks.length} brani`].filter(Boolean).join(' · ')}
        </span>
      </div>
      <div className="list-actions">
        <button className="primary" disabled={!tracks.length || !!tp.busy} onClick={() => void tp.play(0)}>
          {tp.busy ? <Spinner /> : <Play fill="currentColor" />} Riproduci
        </button>
        {saving ? (
          <button disabled className="saving">
            <Spinner /> {saving.done}/{saving.total}
          </button>
        ) : (
          <>
            <button onClick={() => void save(false)}>
              <Plus /> Salva
            </button>
            <button onClick={() => void save(true)} aria-label="Salva e scarica">
              <Download /> Scarica
            </button>
          </>
        )}
        <button className="share-btn" onClick={() => void shareSpotify(al.name, al.uri, `${al.name} – ${al.artists.join(', ')}`)} aria-label="Condividi">
          <Share2 />
        </button>
      </div>
      {tracks.map((t, i) => (
        <TrackRow key={t.uri} t={t} i={i} busy={tp.busy === t.uri} onPlay={() => void tp.play(i)} />
      ))}
    </div>
  )
}

function Loading({ title }: { title: string }) {
  return (
    <div className="lib">
      <PageTop title={title} />
      <div className="page-loading">
        <Spinner size={30} />
      </div>
    </div>
  )
}

function Failed({ title, err }: { title: string; err: string }) {
  return (
    <div className="lib">
      <PageTop title={title} />
      <div className="notice error">{err}</div>
    </div>
  )
}

/* ------------------------------------------------------------- search results */

/** artists and albums found on Spotify, above the song results */
export function CatalogResults({ query }: { query: string }) {
  const [r, setR] = useState<{ artists: SpArtistRef[]; albums: SpRelease[]; playlists?: SpPlaylistRef[] } | null>(null)
  useEffect(() => {
    let alive = true
    setR(null)
    if (query.trim().length < 2) return
    engine
      .spSearch(query)
      .then((x) => alive && setR(x))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [query])
  if (!r) return null
  return (
    <>
      <Shelf title="Artisti" items={r.artists.slice(0, 6)} round recent />
      <Shelf title="Album" items={r.albums.slice(0, 8)} recent />
      <Shelf title="Playlist" items={(r.playlists ?? []).slice(0, 8)} recent />
    </>
  )
}

/** "Salva" / "Scarica": the tracks become a playlist of the library, filled song by song */
function useSaver() {
  const store = useStore()
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(null)
  const save = async (name: string, source: string, tracks: SpTrack[], andDownload: boolean) => {
    if (saving) return
    const pid = store.createPlaylist(name, [], source)
    setSaving({ done: 0, total: tracks.length })
    let found = 0
    for (let i = 0; i < tracks.length; i++) {
      const [song] = await songsFor([tracks[i]], store.getSong)
      if (song) {
        found++
        store.addToLibrary(song, true)
        store.addToPlaylist(pid, [song.id])
        if (andDownload) store.download([song.id])
      }
      setSaving({ done: i + 1, total: tracks.length })
    }
    setSaving(null)
    store.showToast(found ? `“${name}”: ${found} brani nella playlist` : 'Nessun brano trovato su YouTube')
  }
  return { saving, save }
}

/* ------------------------------------------------------------- Spotify playlist */

function PlaylistPage({ uri }: { uri: string }) {
  const [pl, setPl] = useState<SpotifyList | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const { saving, save } = useSaver()
  useEffect(() => {
    engine
      .spPlaylist(uri)
      .then(setPl)
      .catch((e) => setErr(errMsg(e)))
  }, [uri])
  const tracks = useMemo<SpTrack[]>(
    () =>
      (pl?.tracks ?? []).map((t) => ({
        uri: t.uri || `x:${t.artist}|${t.title}`,
        title: t.title,
        artists: t.artist.split(', ').filter(Boolean),
        artistUris: t.artistUri ? [t.artistUri] : [],
        duration: t.duration,
        image: t.image || pl?.image
      })),
    [pl]
  )
  const tp = useTrackPlayer(tracks, pl?.name ?? 'Playlist')
  if (err) return <Failed title="Playlist" err={err} />
  if (!pl) return <Loading title="Playlist" />
  return (
    <div className="lib catalog">
      <PageTop title="" />
      <div className="album-hero">
        {pl.image ? <img src={pl.image} alt="" /> : <span className="tile-ph" />}
        <h1>{pl.name}</h1>
        <span className="muted small">{[pl.owner, `${tracks.length} brani`].filter(Boolean).join(' · ')}</span>
      </div>
      <div className="list-actions">
        <button className="primary" disabled={!tracks.length || !!tp.busy} onClick={() => void tp.play(0)}>
          {tp.busy ? <Spinner /> : <Play fill="currentColor" />} Riproduci
        </button>
        <button disabled={tracks.length < 2 || !!tp.busy} onClick={() => void tp.play(Math.floor(Math.random() * tracks.length), true)} aria-label="Casuale">
          <Shuffle />
        </button>
        {saving ? (
          <button disabled className="saving">
            <Spinner /> {saving.done}/{saving.total}
          </button>
        ) : (
          <>
            <button onClick={() => void save(pl.name, uri, tracks, false)}>
              <Plus /> Salva
            </button>
            <button onClick={() => void save(pl.name, uri, tracks, true)} aria-label="Salva e scarica">
              <Download />
            </button>
          </>
        )}
        <button className="share-btn" onClick={() => void shareSpotify(pl.name, uri)} aria-label="Condividi">
          <Share2 />
        </button>
      </div>
      {tracks.map((t, i) => (
        <TrackRow key={`${t.uri}:${i}`} t={t} i={i} showArt busy={tp.busy === t.uri} onPlay={() => void tp.play(i)} />
      ))}
    </div>
  )
}
