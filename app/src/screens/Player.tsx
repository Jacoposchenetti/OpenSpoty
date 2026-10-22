import { ChevronDown, Guitar, Heart, ListMusic, Minus, NotebookPen, Pause, Play, Plus, Pointer, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, X, Share2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Sheet, SongThumb, Spinner, useBackHandler } from '../components/ui'
import { nameParts } from '../lib/media'
import { fmtTime } from '../lib/format'
import { isNative } from '../lib/native'
import { StemPlayer } from '../lib/player'
import type { MixState, Song } from '../lib/types'
import { usePlayback } from '../playback'
import { useOpenArtist } from './Catalog'
import { LyricsView } from './Lyrics'
import { shareSong } from '../lib/share'
import { useStore } from '../store'

/* Full-screen player: the stem mixer of the song that is playing. */
export function Player() {
  const store = useStore()
  const openArtist = useOpenArtist()
  const pb = usePlayback()
  const song = pb.now ? store.getSong(pb.now.songId) ?? null : null
  const [pos, setPos] = useState(0)
  const [showQueue, setShowQueue] = useState(false)
  const [showTempo, setShowTempo] = useState(false)
  const [showNotes, setShowNotes] = useState(false)
  const [showLyrics, setShowLyrics] = useState(false)
  const scrubbing = useRef(false)
  const close = () => store.setPlayerOpen(false)
  useBackHandler(close)

  useEffect(() => {
    let raf = 0
    const tick = () => {
      if (!scrubbing.current) setPos(pb.position())
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [pb])

  if (!song || !pb.now) {
    return (
      <div className="player">
        <header className="player-head">
          <button className="icon-btn" onClick={close} aria-label="Chiudi">
            <ChevronDown />
          </button>
        </header>
        <div className="empty">
          <p className="big">Niente in riproduzione</p>
          <p>Tocca una canzone nella libreria per farla partire.</p>
        </div>
      </div>
    )
  }

  const mix = pb.mix
  const update = (next: MixState) => pb.setMix(next)
  const ready = !pb.loading && !pb.error
  const duration = pb.duration
  const ctx = pb.now
  const nextUp = pb.queue.length ? store.getSong(pb.queue[0]) : ctx.index + 1 < ctx.contextIds.length ? store.getSong(ctx.contextIds[ctx.index + 1]) : null

  return (
    <div className="player">
      <header className="player-head">
        <button className="icon-btn" onClick={close} aria-label="Chiudi il player">
          <ChevronDown />
        </button>
        <SongThumb song={song} size={40} />
        <div className="player-title" onClick={() => void openArtist(song)} role="button">
          <div className="title">{nameParts(song.title).name}</div>
          <div className="sub artist-link">{nameParts(song.title).artist || (ctx.fromQueue ? 'Dalla coda' : ctx.contextName || 'In riproduzione')}</div>
          <div className="sub">
            {nameParts(song.title).artist ? (ctx.fromQueue ? 'Dalla coda' : ctx.contextName || 'In riproduzione') : ''}
            {nextUp ? `${nameParts(song.title).artist ? ' · ' : ''}poi: ${nameParts(nextUp.title).name}` : ''}
          </div>
        </div>
        <button className="icon-btn" onClick={() => void shareSong(song).then((r) => r === 'copied' && store.showToast('Link copiato'))} aria-label="Condividi">
          <Share2 />
        </button>
      </header>

      <div className="player-actions">
        <button className={pb.shuffle ? 'on' : ''} onClick={pb.toggleShuffle} aria-label="Casuale">
          <Shuffle />
          <small>Casuale</small>
        </button>
        <button className={pb.repeat !== 'off' ? 'on' : ''} onClick={pb.cycleRepeat} aria-label="Ripeti">
          {pb.repeat === 'one' ? <Repeat1 /> : <Repeat />}
          <small>{pb.repeat === 'off' ? 'Ripeti' : pb.repeat === 'all' ? 'Tutto' : 'Brano'}</small>
        </button>
        <button
          className={song.liked ? 'on heart' : 'heart'}
          onClick={() => store.updateSong(song.id, song.liked ? { liked: false } : { liked: true, likedAt: Date.now() })}
          aria-label="Preferito"
        >
          <Heart fill={song.liked ? 'currentColor' : 'none'} />
          <small>Mi piace</small>
        </button>
        <button className={song.notes ? 'on' : ''} onClick={() => setShowNotes(true)} aria-label="Note">
          <NotebookPen />
          <small>Note</small>
        </button>
        <button className="suona" onClick={() => setShowLyrics(true)} aria-label="Suona">
          <Guitar />
          <small>Suona</small>
        </button>
      </div>
      {song.notes && (
        <button className="song-notes" onClick={() => setShowNotes(true)}>
          {song.notes}
        </button>
      )}

      {pb.loading && (
        <div className="notice loading">
          <Spinner /> Preparo la canzone…
        </div>
      )}
      {pb.error && <div className="notice error">{pb.error}</div>}

      <div className="listen">
        <SongThumb song={song} size={260} />
      </div>

      <div className="seek">
        <span>{fmtTime(pos)}</span>
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.1}
          value={Math.min(pos, duration)}
          disabled={!ready}
          onPointerDown={() => (scrubbing.current = true)}
          onChange={(e) => setPos(Number(e.target.value))}
          onPointerUp={(e) => {
            scrubbing.current = false
            pb.seek(Number((e.target as HTMLInputElement).value))
          }}
          onKeyUp={(e) => pb.seek(Number((e.target as HTMLInputElement).value))}
          aria-label="Posizione"
        />
        <span>{fmtTime(duration)}</span>
      </div>

      <div className="transport">
        <button className="t-btn" onClick={pb.prev} aria-label="Precedente o inizio">
          <SkipBack fill="currentColor" />
        </button>
        <button className="t-btn" disabled={!ready} onClick={() => pb.seek(pos - 5)} aria-label="Indietro 5 secondi">
          −5
        </button>
        <button className="t-play" disabled={!ready} onClick={pb.toggle} aria-label={pb.playing ? 'Pausa' : 'Play'}>
          {pb.loading ? <Spinner size={34} /> : pb.playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
        </button>
        <button className="t-btn" disabled={!ready} onClick={() => pb.seek(pos + 5)} aria-label="Avanti 5 secondi">
          +5
        </button>
        <button className="t-btn" disabled={!nextUp} onClick={pb.next} aria-label="Successiva">
          <SkipForward fill="currentColor" />
        </button>
      </div>
      <div className="master">
        <span>Volume</span>
        <input
          type="range"
          min={0}
          max={1.5}
          step={0.01}
          value={mix.master}
          onChange={(e) => update({ ...mix, master: Number(e.target.value) })}
          aria-label="Volume generale"
        />
        <button className="t-small" onClick={() => setShowQueue(true)}>
          <ListMusic /> Coda{pb.queue.length ? ` (${pb.queue.length})` : ''}
        </button>
      </div>

      {showQueue && <QueueSheet onClose={() => setShowQueue(false)} />}
      {pb.countingIn && <div className="countin">1 · 2 · 3 · 4</div>}
      {showLyrics && <LyricsView key={song.id} songId={song.id} onClose={() => setShowLyrics(false)} />}
      {showNotes && (
        <NotesSheet initial={song.notes ?? ''} onSave={(t) => store.updateSong(song.id, { notes: t.trim() || undefined })} onClose={() => setShowNotes(false)} />
      )}
      {showTempo && <TempoSheet song={song} mix={mix} onChange={update} onClose={() => setShowTempo(false)} />}
    </div>
  )
}


function NotesSheet({ initial, onSave, onClose }: { initial: string; onSave: (t: string) => void; onClose: () => void }) {
  const [t, setT] = useState(initial)
  return (
    <Sheet title="Note per questo brano" onClose={() => (onSave(t), onClose())}>
      <textarea
        className="notes-input"
        autoFocus
        rows={5}
        placeholder="Es. capo al 3° tasto · attacco dopo 4 battute · finale lungo"
        value={t}
        onChange={(e) => setT(e.target.value)}
      />
      <button className="primary" onClick={() => (onSave(t), onClose())}>
        Salva
      </button>
    </Sheet>
  )
}

export function tempoLabel(mix: MixState): string {
  const p = mix.pitch ?? 0
  const sp = mix.speed ?? 1
  const parts = []
  if (p) parts.push(`${p > 0 ? '+' : ''}${p} st`)
  if (Math.abs(sp - 1) > 0.001) parts.push(`${Math.round(sp * 100)}%`)
  return parts.join(' · ')
}

export function TempoSheet({ song, mix, onChange, onClose }: { song: Song; mix: MixState; onChange: (m: MixState) => void; onClose: () => void }) {
  const store = useStore()
  const taps = useRef<number[]>([])
  const bpm = song.bpm || 0
  const setBpm = (v: number) => {
    const b = Math.round(Math.max(30, Math.min(300, v)) * 2) / 2
    store.updateSong(song.id, { bpm: b })
    if (isNative) void StemPlayer.setBpm({ songId: song.id, bpm: b }).catch(() => undefined)
  }
  const tap = () => {
    const now = performance.now()
    const t = taps.current.filter((x) => now - x < 3000)
    t.push(now)
    taps.current = t
    if (t.length >= 3) setBpm((60000 * (t.length - 1)) / (t[t.length - 1] - t[0]))
  }
  const pitch = mix.pitch ?? 0
  const speed = mix.speed ?? 1
  const setPitch = (v: number) => onChange({ ...mix, pitch: Math.max(-6, Math.min(6, v)) })
  const setSpeed = (v: number) => onChange({ ...mix, speed: Math.max(0.5, Math.min(1.5, Math.round(v * 100) / 100)) })
  return (
    <Sheet title="Tono, velocità e tempo" onClose={onClose}>
      <p className="muted small">Si salvano per questa canzone. Il tono non cambia la velocità e viceversa.</p>
      <div className="stepper">
        <span className="stepper-label">Tonalità</span>
        <button onClick={() => setPitch(pitch - 1)} aria-label="Mezzo tono sotto">
          <Minus />
        </button>
        <span className="stepper-value">{pitch === 0 ? 'originale' : `${pitch > 0 ? '+' : ''}${pitch} semitoni`}</span>
        <button onClick={() => setPitch(pitch + 1)} aria-label="Mezzo tono sopra">
          <Plus />
        </button>
      </div>
      <div className="stepper">
        <span className="stepper-label">Velocità</span>
        <button onClick={() => setSpeed(speed - 0.05)} aria-label="Più lenta">
          <Minus />
        </button>
        <span className="stepper-value">{Math.round(speed * 100)}%</span>
        <button onClick={() => setSpeed(speed + 0.05)} aria-label="Più veloce">
          <Plus />
        </button>
      </div>
      <div className="presets">
        <button onClick={() => setSpeed(0.75)}>Studio 75%</button>
        <button onClick={() => setSpeed(0.9)}>90%</button>
        <button onClick={() => onChange({ ...mix, pitch: 0, speed: 1 })}>Originali</button>
      </div>
      <div className="q-head">Tempo e count-in</div>
      <div className="stepper">
        <span className="stepper-label">BPM</span>
        <button onClick={() => bpm && setBpm(bpm / 2)} aria-label="Metà">
          ÷2
        </button>
        <span className="stepper-value">{bpm ? `${bpm}` : song.bpm === undefined ? 'calcolo…' : '—'}</span>
        <button onClick={() => bpm && setBpm(bpm * 2)} aria-label="Doppio">
          ×2
        </button>
      </div>
      <button className="tap" onClick={tap}>
        <Pointer /> Tocca a tempo (tap tempo)
      </button>
      <div className="seg">
        {[0, 4, 8].map((b) => (
          <button key={b} className={store.countIn === b ? 'active' : ''} onClick={() => store.setCountIn(b)}>
            {b === 0 ? 'Count-in no' : b === 4 ? '1 battuta' : '2 battute'}
          </button>
        ))}
      </div>
      <p className="muted small">
        Con il count-in, quando premi play senti {store.countIn || 4} colpi al tempo del brano prima che parta (vale per tutte le canzoni). Se il BPM è
        il doppio o la metà di quello giusto, correggilo con ×2 / ÷2 o battendo il tempo.
      </p>
      {!isNative && <p className="muted small">Tono e velocità per ora funzionano solo sul telefono.</p>}
    </Sheet>
  )
}

function QueueSheet({ onClose }: { onClose: () => void }) {
  const store = useStore()
  const pb = usePlayback()
  const byId = new Map(store.allSongs.map((s) => [s.id, s]))
  const ctx = pb.now!
  const rest = ctx.contextIds.slice(ctx.index + 1).map((id) => byId.get(id)).filter((s) => !!s)
  const current = byId.get(ctx.songId)
  return (
    <Sheet title="Coda" onClose={onClose}>
      {current && (
        <div className="q-row now">
          <SongThumb song={current} size={40} />
          <span className="pick-title">{current.title}</span>
          <span className="pill">ora</span>
        </div>
      )}
      <div className="q-head">Prossime in coda</div>
      {pb.queue.length === 0 && <p className="muted small">Vuota: usa “Metti in coda” dal menu ⋮ di un brano.</p>}
      {pb.queue.map((id, i) => {
        const s = byId.get(id)
        if (!s) return null
        return (
          <div key={`${id}:${i}`} className="q-row">
            <SongThumb song={s} size={40} />
            <span className="pick-title">{s.title}</span>
            <button className="icon-btn" onClick={() => pb.dequeue(i)} aria-label="Togli dalla coda">
              <X />
            </button>
          </div>
        )
      })}
      {rest.length > 0 && <div className="q-head">Poi da “{ctx.contextName || 'libreria'}”</div>}
      {rest.map((s, i) => (
        <button key={`${s.id}:${i}`} className="q-row" onClick={() => (pb.playList(ctx.contextIds, ctx.index + 1 + i, ctx.contextName), onClose())}>
          <SongThumb song={s} size={40} />
          <span className="pick-title">{s.title}</span>
        </button>
      ))}
      <label className="switch-row">
        <input type="checkbox" checked={pb.stopAtEnd} onChange={(e) => pb.setStopAtEnd(e.target.checked)} />
        <span>
          <b>Ferma a fine brano</b>
          <br />
          <span className="muted small">Utile dal vivo: non parte da sola la canzone successiva.</span>
        </span>
      </label>
    </Sheet>
  )
}
