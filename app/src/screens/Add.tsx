import { Check, Play, Plus, SlidersVertical, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { engine } from '../lib/engine'
import { errMsg, fmtTime } from '../lib/format'
import type { YtResult } from '../lib/native'
import { useImports, type Import } from '../imports'
import { usePlayback } from '../playback'
import { useStore } from '../store'
import { Spinner } from '../components/ui'
import { CatalogResults } from './Catalog'
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

  return (
    <section className="card">
      <div className="search">
        <input
          placeholder="Cerca una canzone o incolla un link"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void runSearch(query)}
          enterKeyHint="search"
          autoCapitalize="off"
          autoCorrect="off"
        />
        <button className="primary" disabled={searching || !query.trim()} onClick={() => void runSearch(query)}>
          {searching ? <Spinner /> : 'Cerca'}
        </button>
      </div>
      {results && <CatalogResults query={results.q} />}
      {(results || searching) && (
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
