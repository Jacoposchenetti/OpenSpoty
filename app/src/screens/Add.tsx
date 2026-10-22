import { ArrowLeft, ArrowUpLeft, Check, Clock, Play, Plus, Search as SearchIcon, SlidersVertical, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { engine } from '../lib/engine'
import { errMsg, fmtTime } from '../lib/format'
import type { YtResult } from '../lib/native'
import { useImports, type Import } from '../imports'
import { usePlayback } from '../playback'
import { useStore } from '../store'
import { Spinner } from '../components/ui'
import { CatalogResults, Shelf } from './Catalog'
import { addRecent, clearRecents, loadRecents, removeRecent, type Recent } from '../lib/recents'
import { buildHome, type Home } from '../lib/home'
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

  // tap = listen right away (streamed, nothing saved); the list plays on
  const playHit = useCallback(
    (hit: Hit) => {
      if (!results) return
      const songs = results.items.map(songOf)
      store.addTemp(songs)
      const hitSong = songs.find((x) => x.id === `yt-${hit.videoId}`)
      if (hitSong) addRecent({ kind: 'song', id: hitSong.id, title: hitSong.title, sub: 'Brano', image: hit.thumbnail })
      playback.playList(
        songs.map((s) => s.id),
        Math.max(0, songs.findIndex((s) => s.id === `yt-${hit.videoId}`)),
        `Ricerca “${results.q}”`
      )
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [results, store, playback]
  )
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

  const splitHit = useCallback(
    async (hit: Hit) => {
      setErr(null)
      try {
        const songId = `yt-${hit.videoId}`
        const have = store.songs.find((s) => s.id === songId)
        if (have?.stems.length) {
          playback.playSong(songId)
          return
        }
        if (have) {
          await store.splitLater(have) // already downloaded: no second download
          return
        }
        const title = titleOf(hit)
        await engine.separate({ youtubeId: hit.videoId, songId, title })
        store.showToast(store.deviceJob?.state === 'running' ? `In coda: “${title}”` : `Preparo “${title}”…`)
      } catch (e) {
        setErr(errMsg(e))
      }
    },
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

      {results && (typing || !focused) && <CatalogResults query={results.q} />}
      {(results || searching) && (typing || !focused) && (
        <div className="results">
          {results && <h3 className="sec">Brani</h3>}
          {searching && !results && (
            <div className="page-loading">
              <Spinner size={26} />
            </div>
          )}
          {results?.items.map((r) => {
            const st = status(r.videoId)
            const song = store.songs.find((s) => s.id === `yt-${r.videoId}`)
            const current = playback.now?.songId === `yt-${r.videoId}`
            const opening = current && playback.loading
            return (
              <div key={r.videoId} className={`result ${current ? 'current' : ''}`}>
                <button className="result-main" onClick={() => playHit(r)}>
                  <span className="result-thumb">
                    <img src={r.thumbnail || `https://i.ytimg.com/vi/${r.videoId}/mqdefault.jpg`} alt="" loading="lazy" />
                    {opening && (
                      <span className="thumb-busy">
                        <Spinner size={22} />
                      </span>
                    )}
                  </span>
                  <span className="result-text">
                    <span className="result-title">{r.title}</span>
                    <span className="row-sub">
                      {r.channel ?? ''}
                      {r.duration ? ` · ${fmtTime(r.duration)}` : ''}
                      {st && <span className="tag">{st}</span>}
                    </span>
                  </span>
                </button>
                <button className="r-act" disabled={!!song} onClick={() => store.addToLibrary(songOf(r))} aria-label="Aggiungi alla libreria">
                  {song ? <Check /> : <Plus />}
                  <small>{song ? 'In libreria' : 'Aggiungi'}</small>
                </button>
                {!song?.stems.length && (
                  <button className="r-act" onClick={() => void splitHit(r)} aria-label="Separa le tracce">
                    <SlidersVertical />
                    <small>Separa</small>
                  </button>
                )}
              </div>
            )
          })}
          {results && !results.items.length && !searching && <p className="muted pad">Nessun risultato.</p>}
        </div>
      )}
      {err && <div className="notice error">{err}</div>}
    </section>
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
  const [home, setHome] = useState<Home | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    buildHome(store.songs)
      .then((h) => alive && setHome(h))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.songs.length])
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
      <Shelf title="Playlist da ascoltare" items={home.playlists} />
      <Shelf title="Ultime uscite dei tuoi artisti" items={home.releases} showArtist />
    </div>
  )
}
