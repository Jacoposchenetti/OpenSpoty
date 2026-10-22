import { AudioLines, MicVocal, Play, Plus, Share2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Spinner } from '../components/ui'
import { capture, loadCaptures, saveCapture, stopCapture, type CaptureEvent, type Captured } from '../lib/capture'
import { engine } from '../lib/engine'
import { errMsg } from '../lib/format'
import type { CaptureMatch } from '../lib/native'
import { share } from '../lib/share'
import type { Song } from '../lib/types'
import { usePlayback } from '../playback'
import { useStore } from '../store'
import { useOpenArtist } from './Catalog'

/* "Cattura": tap, let it listen, find out the song (Shazam). Then listen to
   it, save it, or open its artist. */
export function CapturePage() {
  const store = useStore()
  const pb = usePlayback()
  const openArtist = useOpenArtist()
  const [busy, setBusy] = useState(false)
  const [ev, setEv] = useState<CaptureEvent | null>(null)
  const [result, setResult] = useState<CaptureMatch | null>(null)
  const [none, setNone] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [history, setHistory] = useState<Captured[]>(loadCaptures)
  const [opening, setOpening] = useState(false)
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
      stopCapture()
    },
    []
  )

  const start = async () => {
    if (busy) {
      stopCapture()
      return
    }
    setBusy(true)
    setErr(null)
    setNone(false)
    setResult(null)
    try {
      const m = await capture((e) => alive.current && setEv(e))
      if (!alive.current) return
      if (m) {
        setResult(m)
        setHistory(saveCapture(m))
      } else setNone(true)
    } catch (e) {
      if (alive.current) setErr(errMsg(e))
    } finally {
      if (alive.current) {
        setBusy(false)
        setEv(null)
      }
    }
  }

  /** the same recording on YouTube Music, as a song of the app */
  const songOf = async (m: CaptureMatch): Promise<Song> => {
    const hit = await engine.matchSong({ title: m.title, artist: m.artist, duration: 0 })
    const id = `yt-${hit.videoId}`
    return (
      store.getSong(id) ?? { id, title: `${m.artist} – ${m.title}`, duration: hit.duration, stems: [], files: {}, source: 'device', addedAt: Date.now(), art: m.image }
    )
  }
  const listen = async (m: CaptureMatch) => {
    setOpening(true)
    try {
      const s = await songOf(m)
      store.addTemp([s])
      pb.playList([s.id], 0, 'Cattura')
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setOpening(false)
    }
  }
  const add = async (m: CaptureMatch) => {
    try {
      store.addToLibrary(await songOf(m))
    } catch (e) {
      setErr(errMsg(e))
    }
  }

  const level = ev?.phase === 'listening' ? ev.level : 0
  return (
    <div className="page flat capture-page">
      <div className="capture-stage">
        <button className={`capture-btn ${busy ? 'on' : ''}`} onClick={() => void start()} aria-label={busy ? 'Ferma' : 'Cattura'}>
          <span className="capture-ring" style={{ transform: `scale(${1 + level * 0.5})` }} />
          <span className="capture-ring r2" style={{ transform: `scale(${1 + level * 0.25})` }} />
          <AudioLines />
        </button>
        <p className="capture-hint">
          {busy
            ? ev?.phase === 'searching'
              ? 'Cerco…'
              : `In ascolto… ${ev ? Math.floor(ev.seconds) : 0} s`
            : 'Tocca per Cattura'}
        </p>
        {busy && <p className="muted small">Avvicina il telefono alla musica. Tocca di nuovo per fermare.</p>}
        {none && <p className="muted">Non l’ho riconosciuta: riprova più vicino alla musica.</p>}
        {err && <div className="notice error">{err}</div>}
      </div>

      {result && <MatchCard m={result} opening={opening} onListen={listen} onAdd={add} onArtist={() => void openArtist({ title: `${result.artist} – ${result.title}` })} onClose={() => setResult(null)} />}

      {history.length > 0 && (
        <section className="card">
          <h2>Catture recenti</h2>
          {history.map((h) => (
            <button key={h.at} className="recent-main" onClick={() => setResult(h)}>
              {h.image ? <img src={h.image} alt="" /> : <span className="recent-ico"><MicVocal /></span>}
              <span className="lib-text">
                <span className="row-title">{h.title}</span>
                <span className="row-sub">
                  {h.artist} · {new Date(h.at).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}
                </span>
              </span>
            </button>
          ))}
        </section>
      )}
    </div>
  )
}

function MatchCard({ m, opening, onListen, onAdd, onArtist, onClose }: {
  m: CaptureMatch
  opening: boolean
  onListen: (m: CaptureMatch) => void
  onAdd: (m: CaptureMatch) => void
  onArtist: () => void
  onClose: () => void
}) {
  return (
    <section className="card match-card">
      <button className="icon-btn match-close" onClick={onClose} aria-label="Chiudi">
        <X />
      </button>
      {m.image && <img className="match-art" src={m.image} alt="" />}
      <h2>{m.title}</h2>
      <button className="link-btn" onClick={onArtist}>
        {m.artist}
      </button>
      <p className="muted small">{[m.album, m.year, m.genre].filter(Boolean).join(' · ')}</p>
      <div className="list-actions">
        <button className="primary" disabled={opening} onClick={() => onListen(m)}>
          {opening ? <Spinner /> : <Play fill="currentColor" />} Ascolta
        </button>
        <button onClick={() => onAdd(m)}>
          <Plus /> Aggiungi
        </button>
        <button className="share-btn" onClick={() => void share({ title: m.title, text: `${m.title} – ${m.artist}`, url: m.url })} aria-label="Condividi">
          <Share2 />
        </button>
      </div>
    </section>
  )
}
