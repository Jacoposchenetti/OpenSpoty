import { ChevronDown, Guitar, Minus, Pause, Play, Plus, Pointer, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, X, EllipsisVertical, Podcast as PodcastIcon, Share2, CircleCheck, CirclePlus, Heart, ListMusic, Users } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { PromptSheet, Sheet, SongThumb, Spinner, useBackHandler } from '../components/ui'
import { nameParts } from '../lib/media'
import { fmtTime } from '../lib/format'
import { isNative } from '../lib/native'
import { StemPlayer } from '../lib/player'
import type { MixState, Song } from '../lib/types'
import { usePlayback } from '../playback'
import { useOpenArtist } from './Catalog'
import { LyricsView } from './Lyrics'
import { saveProgress } from '../lib/podcasts'
import { SongMenu } from './Library'
import { useStore } from '../store'
import { localeTag, t as tr } from '../lib/i18n'
import { useHostedJam } from '../lib/jam'
import { JamSheet } from './Jam'
import { LyricsCard } from './LyricsCard'
import { setVideoOn, songVideo, useVideoOn } from '../lib/canvas'

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
  const scrubbing = useRef(false)
  const videoOn = useVideoOn()
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
        <div className="player-title from">
          <div className="sub">{ctx.fromQueue ? tr('Dalla coda') : song.episode ? 'Podcast' : tr('In riproduzione da')}</div>
          <div className="title">{ctx.fromQueue ? '' : ctx.contextName || tr('In riproduzione')}</div>
        </div>
        {!song.episode && (
          <button className="head-pill suona" onClick={() => setShowLyrics(true)} aria-label={tr('Suona')}>
            <Guitar />
            <small>{tr('Suona')}</small>
          </button>
        )}
        <button className="icon-btn" onClick={() => setMenu(true)} aria-label={tr('Opzioni del brano')}>
          <EllipsisVertical />
        </button>
      </header>
      {menu && !song.episode && (
        <SongMenu
          song={song}
          index={0}
          playlist={null}
          onClose={() => setMenu(false)}
          extra={{
            onNotes: () => (setMenu(false), setShowNotes(true)),
            onQueue: () => (setMenu(false), setShowQueue(true)),
            video: { on: videoOn, toggle: () => (setMenu(false), setVideoOn(!videoOn)) }
          }}
        />
      )}
      {menu && song.episode && <EpisodeMenu song={song} onClose={() => setMenu(false)} />}

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
        <CoverVideo song={song} />
      </div>

      <div className="now-title">
        <span className="now-text" onClick={() => void openArtist(song)} role="button">
          <b>{nameParts(song.title).name}</b>
          <span>{nameParts(song.title).artist || (song.episode ? song.episode.podcast : '')}</span>
        </span>
        {!song.episode && <SaveButton song={song} />}
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

      <div className="transport sp">
        {song.episode ? (
          <>
            <button className="t-btn" onClick={() => update({ ...mix, speed: nextSpeed(mix.speed ?? 1) })} aria-label={tr('Velocità')}>
              <small className="t-speed">{fmtSpeed(mix.speed ?? 1)}</small>
            </button>
            <button className="t-btn" disabled={!ready} onClick={() => pb.seek(pos - 15)} aria-label={tr('Indietro')}>
              <small className="t-speed">−15</small>
            </button>
          </>
        ) : (
          <>
            <button className={`t-btn ${pb.shuffle ? 'on' : ''}`} onClick={pb.toggleShuffle} aria-label={tr('Casuale')}>
              <Shuffle />
            </button>
            <button className="t-btn" onClick={pb.prev} aria-label={tr('Precedente o inizio')}>
              <SkipBack fill="currentColor" />
            </button>
          </>
        )}
        <button className="t-play" disabled={!ready} onClick={pb.toggle} aria-label={pb.playing ? tr('Pausa') : 'Play'}>
          {pb.loading ? <Spinner size={34} /> : pb.playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
        </button>
        {song.episode ? (
          <>
            <button className="t-btn" disabled={!ready} onClick={() => pb.seek(pos + 30)} aria-label={tr('Avanti')}>
              <small className="t-speed">+30</small>
            </button>
            <button className="t-btn" disabled={!nextUp} onClick={pb.next} aria-label={tr('Successiva')}>
              <SkipForward fill="currentColor" />
            </button>
          </>
        ) : (
          <>
            <button className="t-btn" disabled={!nextUp} onClick={pb.next} aria-label={tr('Successiva')}>
              <SkipForward fill="currentColor" />
            </button>
            <button className={`t-btn ${pb.repeat !== 'off' ? 'on' : ''}`} onClick={pb.cycleRepeat} aria-label={tr('Ripeti')}>
              {pb.repeat === 'one' ? <Repeat1 /> : <Repeat />}
            </button>
          </>
        )}
      </div>

      <LyricsCard key={song.id} song={song} />

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
  const jam = useHostedJam()
  const [jamOpen, setJamOpen] = useState(false)
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
      {jam.active && (
        <>
          <div className="q-head">
            {tr('Coda della Jam')} ({jam.queue?.length ?? 0})
          </div>
          {(jam.queue ?? []).map((it) => (
            <div key={it.key} className="q-row">
              {it.art && !it.art.startsWith('/') ? <img className="thumb" src={it.art} alt="" style={{ width: 40, height: 40 }} /> : <span className="thumb ph" style={{ width: 40, height: 40 }} />}
              <span className="pick-title">
                {it.name || it.title}
                <small className="muted block">{tr('da {name}', { name: it.by || jam.host || '' })}</small>
              </span>
            </div>
          ))}
          <button className="small" onClick={() => setJamOpen(true)}>
            <Users /> {tr('Apri la Jam')}
          </button>
        </>
      )}
      {jamOpen && <JamSheet onClose={() => setJamOpen(false)} />}
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

/** the cover, or a few seconds of the song's music video looping over it (lib/canvas.ts) */
function CoverVideo({ song }: { song: Song }) {
  const on = useVideoOn()
  const [url, setUrl] = useState<string | null>(null)
  const [shown, setShown] = useState(false)
  const loopAt = useRef(0)
  useEffect(() => {
    setUrl(null)
    setShown(false)
    if (!on || song.episode) return
    let live = true
    void songVideo(song).then((u) => live && setUrl(u))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song.id, on])
  return (
    <div className="cover-video">
      <SongThumb song={song} size={260} />
      {url && (
        <video
          src={url}
          muted
          playsInline
          autoPlay
          preload="auto"
          className={shown ? 'on' : ''}
          onLoadedMetadata={(e) => {
            // a stretch from about a third in (past the intro), looped like a Canvas
            const v = e.currentTarget
            loopAt.current = Math.min(45, Math.max(0, v.duration * 0.3))
            v.currentTime = loopAt.current
          }}
          onPlaying={() => setShown(true)}
          onTimeUpdate={(e) => {
            const v = e.currentTarget
            if (v.currentTime > loopAt.current + 9 || v.ended) v.currentTime = loopAt.current
          }}
          onError={() => setUrl(null)}
        />
      )}
    </div>
  )
}

/** like Spotify's: + saves the song in "Brani che ti piacciono"; the green tick (saved somewhere) opens "Salvato in" */
function SaveButton({ song }: { song: Song }) {
  const store = useStore()
  const [open, setOpen] = useState(false)
  const inLib = store.songs.some((s) => s.id === song.id)
  const saved = inLib && (!!song.liked || store.playlists.some((p) => p.songIds.includes(song.id)))
  const save = () => {
    if (!inLib) store.addToLibrary(song, true)
    store.updateSong(song.id, { liked: true, likedAt: Date.now() })
    store.showToast(tr('Aggiunta a “Brani che ti piacciono”'))
  }
  return (
    <>
      <button className={`save-btn ${saved ? 'on' : ''}`} onClick={() => (saved ? setOpen(true) : save())} aria-label={saved ? tr('Salvato in…') : tr('Salva')}>
        {saved ? <CircleCheck /> : <CirclePlus />}
      </button>
      {open && <SavedIn song={song} onClose={() => setOpen(false)} />}
    </>
  )
}

/** where the song is saved: the liked songs and every playlist, each one a tap to add or remove */
function SavedIn({ song, onClose }: { song: Song; onClose: () => void }) {
  const store = useStore()
  const [creating, setCreating] = useState(false)
  const keep = () => {
    if (!store.songs.some((s) => s.id === song.id)) store.addToLibrary(song, true)
  }
  if (creating) {
    return (
      <PromptSheet
        title={tr('Nuova playlist')}
        placeholder={tr('Nome della playlist')}
        confirm={tr('Crea')}
        onDone={(name) => (keep(), store.createPlaylist(name, [song.id]), setCreating(false))}
        onClose={() => setCreating(false)}
      />
    )
  }
  return (
    <Sheet
      title={
        <span className="saved-in-head">
          {tr('Salvato in')}
          <button className="link-green" onClick={() => setCreating(true)}>
            {tr('Nuova playlist')}
          </button>
        </span>
      }
      onClose={onClose}
    >
      <button className="saved-row" onClick={() => (keep(), store.updateSong(song.id, song.liked ? { liked: false } : { liked: true, likedAt: Date.now() }))}>
        <span className="saved-cover liked">
          <Heart fill="currentColor" />
        </span>
        <span className="saved-name">{tr('Brani che ti piacciono')}</span>
        {song.liked ? <CircleCheck className="saved-mark on" /> : <CirclePlus className="saved-mark" />}
      </button>
      {store.playlists.map((p) => {
        const i = p.songIds.indexOf(song.id)
        const first = p.songIds.length ? store.getSong(p.songIds[0]) : undefined
        return (
          <button key={p.id} className="saved-row" onClick={() => (i >= 0 ? store.removeFromPlaylist(p.id, i) : (keep(), store.addToPlaylist(p.id, [song.id])))}>
            {first ? <SongThumb song={first} size={52} /> : <span className="saved-cover"><ListMusic /></span>}
            <span className="saved-name">{p.name}</span>
            {i >= 0 ? <CircleCheck className="saved-mark on" /> : <CirclePlus className="saved-mark" />}
          </button>
        )
      })}
    </Sheet>
  )
}
