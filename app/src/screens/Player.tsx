import { ChevronDown, Guitar, Heart, ListMusic, Minus, NotebookPen, Pause, Play, Plus, Pointer, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, X, EllipsisVertical, Gauge, Podcast as PodcastIcon, Share2, CircleCheck, ScrollText } from 'lucide-react'
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
import { TranscriptView } from './Transcript'
import { saveProgress } from '../lib/podcasts'
import { SongMenu } from './Library'
import { useStore } from '../store'
import { localeTag, t as tr } from '../lib/i18n'

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
  const [menu, setMenu] = useState(false)
  const [showTranscript, setShowTranscript] = useState(false)
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
          <button className="icon-btn" onClick={close} aria-label={tr('Chiudi')}>
            <ChevronDown />
          </button>
        </header>
        <div className="empty">
          <p className="big">{tr('Niente in riproduzione')}</p>
          <p>{tr('Tocca una canzone nella libreria per farla partire.')}</p>
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
        <button className="icon-btn" onClick={close} aria-label={tr('Chiudi il player')}>
          <ChevronDown />
        </button>
        <SongThumb song={song} size={40} />
        <div className="player-title" onClick={() => void openArtist(song)} role="button">
          <div className="title">{nameParts(song.title).name}</div>
          <div className="sub artist-link">{nameParts(song.title).artist || (ctx.fromQueue ? tr('Dalla coda') : ctx.contextName || tr('In riproduzione'))}</div>
          <div className="sub">
            {nameParts(song.title).artist ? (ctx.fromQueue ? tr('Dalla coda') : ctx.contextName || tr('In riproduzione')) : ''}
            {nextUp ? `${nameParts(song.title).artist ? ' · ' : ''}${tr('poi:')} ${nameParts(nextUp.title).name}` : ''}
          </div>
        </div>
        <button className="icon-btn" onClick={() => setMenu(true)} aria-label={tr('Opzioni del brano')}>
          <EllipsisVertical />
        </button>
      </header>
      {menu && !song.episode && <SongMenu song={song} index={0} playlist={null} onClose={() => setMenu(false)} />}
      {menu && song.episode && <EpisodeMenu song={song} onClose={() => setMenu(false)} />}

      <div className="player-actions">
        {song.episode ? (
          <button onClick={() => update({ ...mix, speed: nextSpeed(mix.speed ?? 1) })} aria-label={tr('Velocità')}>
            <Gauge />
            <small>{fmtSpeed(mix.speed ?? 1)}</small>
          </button>
        ) : null}
        {!song.episode && <button className={pb.shuffle ? 'on' : ''} onClick={pb.toggleShuffle} aria-label={tr('Casuale')}>
          <Shuffle />
          <small>{tr('Casuale')}</small>
        </button>}
        <button className={pb.repeat !== 'off' ? 'on' : ''} onClick={pb.cycleRepeat} aria-label={tr('Ripeti')}>
          {pb.repeat === 'one' ? <Repeat1 /> : <Repeat />}
          <small>{pb.repeat === 'off' ? tr('Ripeti') : pb.repeat === 'all' ? tr('Tutto') : tr('Brano')}</small>
        </button>
        {!song.episode && <button
          className={song.liked ? 'on heart' : 'heart'}
          onClick={() => store.updateSong(song.id, song.liked ? { liked: false } : { liked: true, likedAt: Date.now() })}
          aria-label={tr('Preferito')}
        >
          <Heart fill={song.liked ? 'currentColor' : 'none'} />
          <small>{tr('Mi piace')}</small>
        </button>}
        <button className={song.notes ? 'on' : ''} onClick={() => setShowNotes(true)} aria-label={tr('Note')}>
          <NotebookPen />
          <small>{tr('Note')}</small>
        </button>
        {song.episode ? (
          <button className="suona" onClick={() => setShowTranscript(true)} aria-label={tr('Testo')}>
            <ScrollText />
            <small>{tr('Testo')}</small>
          </button>
        ) : (
          <button className="suona" onClick={() => setShowLyrics(true)} aria-label={tr('Suona')}>
            <Guitar />
            <small>{tr('Suona')}</small>
          </button>
        )}
      </div>
      {song.notes && (
        <button className="song-notes" onClick={() => setShowNotes(true)}>
          {song.notes}
        </button>
      )}

      {pb.loading && (
        <div className="notice loading">
          <Spinner /> {song.episode ? tr('Preparo l’episodio…') : tr('Preparo la canzone…')}
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
          aria-label={tr('Posizione')}
        />
        {/* what is left to the end (songs and episodes alike) */}
        <span>-{fmtTime(Math.max(0, duration - pos))}</span>
      </div>

      <div className="transport">
        <button className="t-btn" onClick={pb.prev} aria-label={tr('Precedente o inizio')}>
          <SkipBack fill="currentColor" />
        </button>
        <button className="t-btn" disabled={!ready} onClick={() => pb.seek(pos - (song.episode ? 15 : 5))} aria-label={tr('Indietro')}>
          {song.episode ? '−15' : '−5'}
        </button>
        <button className="t-play" disabled={!ready} onClick={pb.toggle} aria-label={pb.playing ? tr('Pausa') : 'Play'}>
          {pb.loading ? <Spinner size={34} /> : pb.playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
        </button>
        <button className="t-btn" disabled={!ready} onClick={() => pb.seek(pos + (song.episode ? 30 : 5))} aria-label={tr('Avanti')}>
          {song.episode ? '+30' : '+5'}
        </button>
        <button className="t-btn" disabled={!nextUp} onClick={pb.next} aria-label={tr('Successiva')}>
          <SkipForward fill="currentColor" />
        </button>
      </div>
      <div className="master">
        <span>{tr('Volume')}</span>
        <input
          type="range"
          min={0}
          max={1.5}
          step={0.01}
          value={mix.master}
          onChange={(e) => update({ ...mix, master: Number(e.target.value) })}
          aria-label={tr('Volume generale')}
        />
        <button className="t-small" onClick={() => setShowQueue(true)}>
          <ListMusic /> {tr('Coda')}{pb.queue.length ? ` (${pb.queue.length})` : ''}
        </button>
      </div>

      {showQueue && <QueueSheet onClose={() => setShowQueue(false)} />}
      {pb.countingIn && <div className="countin">1 · 2 · 3 · 4</div>}
      {showLyrics && <LyricsView key={song.id} songId={song.id} onClose={() => setShowLyrics(false)} />}
      {showTranscript && <TranscriptView key={song.id} songId={song.id} onClose={() => setShowTranscript(false)} />}
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
    <Sheet title={tr('Note per questo brano')} onClose={() => (onSave(t), onClose())}>
      <textarea
        className="notes-input"
        autoFocus
        rows={5}
        placeholder={tr('Es. capo al 3° tasto · attacco dopo 4 battute · finale lungo')}
        value={t}
        onChange={(e) => setT(e.target.value)}
      />
      <button className="primary" onClick={() => (onSave(t), onClose())}>
        {tr('Salva')}
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
    <Sheet title={tr('Tono, velocità e tempo')} onClose={onClose}>
      <p className="muted small">{tr('Si salvano per questa canzone. Il tono non cambia la velocità e viceversa.')}</p>
      <div className="stepper">
        <span className="stepper-label">{tr('Tonalità')}</span>
        <button onClick={() => setPitch(pitch - 1)} aria-label={tr('Mezzo tono sotto')}>
          <Minus />
        </button>
        <span className="stepper-value">{pitch === 0 ? tr('originale') : `${pitch > 0 ? '+' : ''}${pitch} ${tr('semitoni')}`}</span>
        <button onClick={() => setPitch(pitch + 1)} aria-label={tr('Mezzo tono sopra')}>
          <Plus />
        </button>
      </div>
      <div className="stepper">
        <span className="stepper-label">{tr('Velocità')}</span>
        <button onClick={() => setSpeed(speed - 0.05)} aria-label={tr('Più lenta')}>
          <Minus />
        </button>
        <span className="stepper-value">{Math.round(speed * 100)}%</span>
        <button onClick={() => setSpeed(speed + 0.05)} aria-label={tr('Più veloce')}>
          <Plus />
        </button>
      </div>
      <div className="presets">
        <button onClick={() => setSpeed(0.75)}>{tr('Studio')} 75%</button>
        <button onClick={() => setSpeed(0.9)}>90%</button>
        <button onClick={() => onChange({ ...mix, pitch: 0, speed: 1 })}>{tr('Originali')}</button>
      </div>
      <div className="q-head">{tr('Tempo e count-in')}</div>
      <div className="stepper">
        <span className="stepper-label">BPM</span>
        <button onClick={() => bpm && setBpm(bpm / 2)} aria-label={tr('Metà')}>
          ÷2
        </button>
        <span className="stepper-value">{bpm ? `${bpm}` : song.bpm === undefined ? tr('calcolo…') : '—'}</span>
        <button onClick={() => bpm && setBpm(bpm * 2)} aria-label={tr('Doppio')}>
          ×2
        </button>
      </div>
      <button className="tap" onClick={tap}>
        <Pointer /> {tr('Tocca a tempo (tap tempo)')}
      </button>
      <div className="seg">
        {[0, 4, 8].map((b) => (
          <button key={b} className={store.countIn === b ? 'active' : ''} onClick={() => store.setCountIn(b)}>
            {b === 0 ? tr('Count-in no') : b === 4 ? tr('1 battuta') : tr('2 battute')}
          </button>
        ))}
      </div>
      <p className="muted small">
        {tr('Con il count-in, quando premi play senti {count} colpi al tempo del brano prima che parta (vale per tutte le canzoni). Se il BPM è il doppio o la metà di quello giusto, correggilo con ×2 / ÷2 o battendo il tempo.', { count: store.countIn || 4 })}
      </p>
      {!isNative && <p className="muted small">{tr('Tono e velocità per ora funzionano solo sul telefono.')}</p>}
    </Sheet>
  )
}

function QueueSheet({ onClose }: { onClose: () => void }) {
  const store = useStore()
  const pb = usePlayback()
  const byId = new Map(store.allSongs.map((s) => [s.id, s]))
  const ctx = pb.now!
  const auto = ctx.autoFrom ?? ctx.contextIds.length
  const restIds = ctx.contextIds.slice(ctx.index + 1)
  const rest = restIds.map((id, i) => ({ s: byId.get(id), at: ctx.index + 1 + i })).filter((x) => !!x.s && x.at < auto)
  const recs = restIds.map((id, i) => ({ s: byId.get(id), at: ctx.index + 1 + i })).filter((x) => !!x.s && x.at >= auto)
  const current = byId.get(ctx.songId)
  return (
    <Sheet title={tr('Coda')} onClose={onClose}>
      {current && (
        <div className="q-row now">
          <SongThumb song={current} size={40} />
          <span className="pick-title">{current.title}</span>
          <span className="pill">{tr('ora')}</span>
        </div>
      )}
      <div className="q-head">{tr('Prossime in coda')}</div>
      {pb.queue.length === 0 && <p className="muted small">{tr('Vuota: usa “Metti in coda” dal menu ⋮ di un brano.')}</p>}
      {pb.queue.map((id, i) => {
        const s = byId.get(id)
        if (!s) return null
        return (
          <div key={`${id}:${i}`} className="q-row">
            <SongThumb song={s} size={40} />
            <span className="pick-title">{s.title}</span>
            <button className="icon-btn" onClick={() => pb.dequeue(i)} aria-label={tr('Togli dalla coda')}>
              <X />
            </button>
          </div>
        )
      })}
      {rest.length > 0 && <div className="q-head">{tr('Poi da “{name}”', { name: ctx.contextName || tr('libreria') })}</div>}
      {rest.map(({ s, at }) => (
        <button key={`${s!.id}:${at}`} className="q-row" onClick={() => (pb.playList(ctx.contextIds, at, ctx.contextName), onClose())}>
          <SongThumb song={s!} size={40} />
          <span className="pick-title">{s!.title}</span>
        </button>
      ))}
      {recs.length > 0 && <div className="q-head">{tr('Riproduzione automatica: brani simili')}</div>}
      {recs.map(({ s, at }) => (
        <button key={`${s!.id}:${at}`} className="q-row" onClick={() => (pb.playList(ctx.contextIds, at, ctx.contextName), onClose())}>
          <SongThumb song={s!} size={40} />
          <span className="pick-title">{s!.title}</span>
        </button>
      ))}
      <label className="switch-row">
        <input type="checkbox" checked={pb.autoplay} onChange={(e) => pb.setAutoplay(e.target.checked)} />
        <span>
          <b>{tr('Riproduzione automatica')}</b>
          <br />
          <span className="muted small">{tr('Quando la lista finisce continua con brani simili, come Spotify.')}</span>
        </span>
      </label>
      <label className="switch-row">
        <input type="checkbox" checked={pb.stopAtEnd} onChange={(e) => pb.setStopAtEnd(e.target.checked)} />
        <span>
          <b>{tr('Ferma a fine brano')}</b>
          <br />
          <span className="muted small">{tr('Utile dal vivo: non parte da sola la canzone successiva.')}</span>
        </span>
      </label>
    </Sheet>
  )
}

const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.75]
const nextSpeed = (v: number) => SPEEDS[(SPEEDS.findIndex((x) => Math.abs(x - v) < 0.01) + 1) % SPEEDS.length]
const fmtSpeed = (v: number) => `${String(v).replace('.', localeTag() === 'it-IT' ? ',' : '.') }×`

/** ⋮ of an episode: its podcast, share it, mark it as heard */
function EpisodeMenu({ song, onClose }: { song: Song; onClose: () => void }) {
  const store = useStore()
  const pb = usePlayback()
  const ep = song.episode!
  const url = song.original?.startsWith('http') ? song.original : ''
  return (
    <Sheet title={ep.podcast} onClose={onClose}>
      <button onClick={() => (store.setPlayerOpen(false), store.openPage({ kind: 'podcast', uri: ep.feed, name: ep.podcast }), onClose())}>
        <PodcastIcon /> {tr('Vai al podcast')}
      </button>
      {url && (
        <button
          onClick={() => {
            onClose()
            void navigator.clipboard?.writeText(url).then(() => store.showToast(tr('Link dell’episodio copiato')))
          }}
        >
          <Share2 /> {tr('Copia il link dell’episodio')}
        </button>
      )}
      <button onClick={() => (saveProgress(song.id, pb.duration, pb.duration), store.showToast(tr('Segnato come ascoltato')), onClose())}>
        <CircleCheck /> {tr('Segna come ascoltato')}
      </button>
    </Sheet>
  )
}
