import { App as CapApp } from '@capacitor/app'
import { AlarmClock, BellRing, Heart, ListMusic, Music, Pause, Play, Plus, Search as SearchIcon, Shuffle, Timer, Trash2, ChevronLeft, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Sheet, SongThumb, Spinner } from '../components/ui'
import { Alarms, DAY_NAMES, dateLabel, daysLabel, fromIso, inWords, isoDate, isPast, loadAlarms, MONTHS, newAlarm, pad, saveAlarmList, whenLabel, type Alarm, type AlarmContent, type AlarmState } from '../lib/alarms'
import { songsFor } from '../lib/catalog'
import { similarSongs } from '../lib/radio'
import { engine } from '../lib/engine'
import { errMsg } from '../lib/format'
import { isDownloaded, nameParts } from '../lib/media'
import { isNative } from '../lib/native'
import type { Song } from '../lib/types'
import { alarmSpec, usePlayback } from '../playback'
import { useStore } from '../store'

type Store = ReturnType<typeof useStore>

/** the songs an alarm plays (at most 40) */
async function songsOf(c: AlarmContent, store: Store): Promise<Song[]> {
  let list: Song[] = []
  if (c.kind === 'all') list = [...store.songs]
  else if (c.kind === 'liked') list = store.songs.filter((s) => s.liked)
  else if (c.kind === 'playlist') list = (store.playlists.find((p) => p.id === c.id)?.songIds ?? []).flatMap((id) => store.getSong(id) ?? [])
  else if (c.kind === 'song') list = store.getSong(c.id) ? [store.getSong(c.id)!] : []
  else if (c.kind === 'album') list = await songsFor((await engine.spAlbum(c.id)).tracks, store.getSong)
  else if (c.kind === 'artist') list = await songsFor((await engine.spArtist(c.id)).topTracks, store.getSong)
  return list.slice(0, 40)
}

/** hands Android the alarms with their songs (also on every start: the library changes);
   "Brani simili": songs like the alarm's ones, streamed after them */
async function pushAlarms(alarms: Alarm[], store: Store): Promise<AlarmState | null> {
  if (!isNative) return null
  const withSpecs = await Promise.all(
    alarms.map(async (a) => {
      const songs = a.enabled ? await songsOf(a.content, store).catch(() => []) : []
      const more =
        a.enabled && a.after === 'similar' && songs.length
          ? await similarSongs(songs.slice(0, 5), new Set(songs.map((s) => s.id)), store.getSong, 15).catch(() => [])
          : []
      return { ...a, after: a.after ?? 'repeat', specs: songs.map(alarmSpec), more: more.map(alarmSpec) }
    })
  )
  return Alarms.save({ alarms: withSpecs })
}

export function AlarmPage() {
  const store = useStore()
  const [alarms, setAlarms] = useState<Alarm[] | null>(null)
  const [state, setState] = useState<AlarmState | null>(null)
  const [editing, setEditing] = useState<Alarm | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    void loadAlarms().then(setAlarms)
    if (isNative) void Alarms.state().then(setState).catch(() => undefined)
  }, [])

  const commit = async (next: Alarm[], downloadFor?: Alarm) => {
    setAlarms(next)
    await saveAlarmList(next)
    try {
      const st = await pushAlarms(next, store)
      if (st) setState(st)
      // the alarm's songs from your library are kept on the phone: it rings also without internet
      if (downloadFor && downloadFor.content.kind !== 'album' && downloadFor.content.kind !== 'artist') {
        const songs = await songsOf(downloadFor.content, store)
        store.download(songs.filter((s) => !isDownloaded(s)).slice(0, 10).map((s) => s.id))
      }
    } catch (e) {
      setErr(errMsg(e))
    }
  }

  const upsert = (a: Alarm) => {
    const list = alarms ?? []
    void commit(list.some((x) => x.id === a.id) ? list.map((x) => (x.id === a.id ? a : x)) : [...list, a], a)
    setEditing(null)
  }

  const sorted = [...(alarms ?? [])].sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute))
  return (
    <div className="page flat alarm-page">
      <SleepTimer />

      <section className="card">
        <div className="card-head">
          <h2>Sveglie</h2>
          <button className="small" onClick={() => setEditing(newAlarm())}>
            <Plus /> Nuova
          </button>
        </div>
        {state?.next && (
          <p className="muted small">
            <BellRing className="inline-ico" /> Prossima sveglia {inWords(state.next.at)}
          </p>
        )}
        {isNative && state && !state.fullScreen && (
          <div className="notice">
            Per vedere la sveglia sopra la schermata di blocco, consenti le notifiche a schermo intero.{' '}
            <button className="small" onClick={() => void Alarms.allowFullScreen()}>
              Consenti
            </button>
          </div>
        )}
        {!isNative && <p className="muted small">Le sveglie suonano sul telefono.</p>}
        {alarms === null ? (
          <div className="page-loading">
            <Spinner />
          </div>
        ) : !sorted.length ? (
          <p className="muted">Svegliati con la tua musica: una canzone, una playlist, un album o un artista.</p>
        ) : (
          sorted.map((a) => (
            <div key={a.id} className={`alarm-row ${a.enabled ? '' : 'off'}`} onClick={() => setEditing(a)}>
              <span className="alarm-time">
                {pad(a.hour)}:{pad(a.minute)}
              </span>
              <span className="alarm-info">
                <span>{a.label || whenLabel(a)}</span>
                <span className="muted small">
                  {isPast(a) ? 'passata · ' : ''}
                  {a.label ? `${whenLabel(a)} · ` : ''}
                  {a.content.name}
                </span>
              </span>
              <label className="toggle" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={a.enabled} onChange={(e) => void commit(sorted.map((x) => (x.id === a.id ? { ...x, enabled: e.target.checked } : x)))} />
                <span />
              </label>
            </div>
          ))
        )}
        {err && <div className="notice error">{err}</div>}
      </section>

      {editing && (
        <AlarmEditor
          alarm={editing}
          isNew={!(alarms ?? []).some((x) => x.id === editing.id)}
          onSave={upsert}
          onDelete={() => (void commit((alarms ?? []).filter((x) => x.id !== editing.id)), setEditing(null))}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------- sleep timer */

function SleepTimer() {
  const pb = usePlayback()
  const [, tick] = useState(0)
  const [dur, setDur] = useState(() => {
    try {
      return Number(localStorage.getItem('stemkit:sleep-last')) || 20 * 60
    } catch {
      return 20 * 60
    }
  })
  // a paused timer keeps its seconds left here (also across tabs and restarts)
  const [paused, setPausedState] = useState<number | null>(() => {
    try {
      return Number(localStorage.getItem('stemkit:sleep-paused')) || null
    } catch {
      return null
    }
  })
  const setPaused = (v: number | null) => {
    setPausedState(v)
    try {
      if (v) localStorage.setItem('stemkit:sleep-paused', String(v))
      else localStorage.removeItem('stemkit:sleep-paused')
    } catch {
      /* private mode */
    }
  }
  const running = pb.sleep.at > Date.now() || pb.sleep.atEnd
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => tick((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [running])
  const start = () => {
    if (dur <= 0) return
    try {
      localStorage.setItem('stemkit:sleep-last', String(dur))
    } catch {
      /* private mode */
    }
    setPaused(null)
    pb.setSleep(dur / 60)
  }
  const left = paused ?? Math.max(0, Math.round((pb.sleep.at - Date.now()) / 1000))
  const pause = () => {
    setPaused(Math.max(1, left))
    pb.setSleep(0)
  }
  const resume = () => {
    if (paused) pb.setSleep(paused / 60)
    setPaused(null)
  }
  const cancel = () => {
    setPaused(null)
    pb.setSleep(0)
  }
  const active = running || paused !== null
  const h = Math.floor(dur / 3600), m = Math.floor((dur % 3600) / 60), sec = dur % 60
  return (
    <section className="card sleep-card">
      <h2>
        <Timer className="inline-ico" /> Timer di spegnimento
      </h2>
      {active ? (
        <div className={`timer-count ${paused ? 'paused' : ''}`}>
          {pb.sleep.atEnd && !paused ? 'Fine brano' : `${pad(Math.floor(left / 3600))} : ${pad(Math.floor((left % 3600) / 60))} : ${pad(left % 60)}`}
        </div>
      ) : (
        <div className="wheels">
          <Wheel max={23} value={h} onChange={(v) => setDur(v * 3600 + m * 60 + sec)} label="ore" />
          <span className="wheel-sep">:</span>
          <Wheel max={59} value={m} onChange={(v) => setDur(h * 3600 + v * 60 + sec)} label="minuti" />
          <span className="wheel-sep">:</span>
          <Wheel max={59} value={sec} onChange={(v) => setDur(h * 3600 + m * 60 + v)} label="secondi" />
        </div>
      )}
      <p className="muted small center">{paused ? 'In pausa.' : running ? 'Poi la musica si ferma.' : 'La musica si ferma dopo questo tempo.'}</p>
      {active ? (
        <div className="sleep-actions">
          {paused ? (
            <button className="primary" onClick={resume}>
              <Play /> Riprendi
            </button>
          ) : (
            !pb.sleep.atEnd && (
              <button onClick={pause}>
                <Pause /> Pausa
              </button>
            )
          )}
          <button className="danger" onClick={cancel}>
            Annulla
          </button>
        </div>
      ) : (
        <button className="primary" disabled={dur <= 0} onClick={start}>
          Avvia
        </button>
      )}
    </section>
  )
}

const ROW = 56

/** a column to scroll, like a clock's timer: the number in the middle is the value */
function Wheel({ max, value, onChange, label }: { max: number; value: number; onChange: (v: number) => void; label: string }) {
  const box = useRef<HTMLDivElement>(null)
  const settle = useRef<number | null>(null)
  useEffect(() => {
    const el = box.current
    if (el && Math.round(el.scrollTop / ROW) !== value) el.scrollTop = value * ROW
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const onScroll = () => {
    if (settle.current) clearTimeout(settle.current)
    settle.current = window.setTimeout(() => {
      const el = box.current
      if (!el) return
      const v = Math.max(0, Math.min(max, Math.round(el.scrollTop / ROW)))
      if (v !== value) onChange(v)
    }, 80)
  }
  return (
    <div className="wheel" ref={box} onScroll={onScroll} aria-label={label} role="listbox">
      <div className="wheel-pad" />
      {Array.from({ length: max + 1 }, (_, i) => (
        <div key={i} className={`wheel-item ${i === value ? 'on' : ''}`} onClick={() => box.current?.scrollTo({ top: i * ROW, behavior: 'smooth' })}>
          {pad(i)}
        </div>
      ))}
      <div className="wheel-pad" />
    </div>
  )
}

/* ------------------------------------------------------------- editor */

function AlarmEditor({ alarm, isNew, onSave, onDelete, onClose }: { alarm: Alarm; isNew: boolean; onSave: (a: Alarm) => void; onDelete: () => void; onClose: () => void }) {
  const [a, setA] = useState(alarm)
  const [picking, setPicking] = useState(false)
  const set = (p: Partial<Alarm>) => setA((x) => ({ ...x, ...p }))
  if (picking) return <ContentPicker onPick={(content) => (set({ content }), setPicking(false))} onClose={() => setPicking(false)} />
  return (
    <Sheet title={isNew ? 'Nuova sveglia' : 'Sveglia'} onClose={onClose}>
      <input
        className="alarm-clock-input"
        type="time"
        value={`${pad(a.hour)}:${pad(a.minute)}`}
        onChange={(e) => {
          const [h, m] = e.target.value.split(':').map(Number)
          if (!Number.isNaN(h)) set({ hour: h, minute: m || 0 })
        }}
      />
      <div className="seg">
        <button className={!a.date ? 'active' : ''} onClick={() => set({ date: undefined })}>
          Ogni settimana
        </button>
        <button className={a.date ? 'active' : ''} onClick={() => set({ date: a.date ?? nextDay(a) })}>
          Una data
        </button>
      </div>
      {a.date ? (
        <>
          <Calendar value={a.date} hour={a.hour} minute={a.minute} onPick={(date) => set({ date })} />
          <p className="muted small center">{dateLabel(a.date)}</p>
        </>
      ) : (
        <>
          <div className="day-chips">
            {DAY_NAMES.map((d, i) => (
              <button
                key={i}
                className={a.days.includes(i + 1) ? 'active' : ''}
                onClick={() => set({ days: a.days.includes(i + 1) ? a.days.filter((x) => x !== i + 1) : [...a.days, i + 1] })}
              >
                {d}
              </button>
            ))}
          </div>
          <p className="muted small center">{daysLabel(a.days)}</p>
        </>
      )}
      <button className="content-pick" onClick={() => setPicking(true)}>
        {a.content.image ? <img src={a.content.image} alt="" /> : <span className="recent-ico">{a.content.kind === 'liked' ? <Heart /> : <Music />}</span>}
        <span className="lib-text">
          <span className="muted small">Svegliami con</span>
          <span className="row-title">{a.content.name}</span>
        </span>
      </button>
      <label className="switch-row">
        <input type="checkbox" checked={a.shuffle} onChange={(e) => set({ shuffle: e.target.checked })} />
        <span>
          <Shuffle className="inline-ico" /> In ordine casuale
        </span>
      </label>
      <div className="after-pick">
        <span className="muted small">Quando le canzoni finiscono</span>
        <div className="seg">
          {(
            [
              ['repeat', 'Ripeti'],
              ['similar', 'Brani simili'],
              ['stop', 'Fermati']
            ] as const
          ).map(([v, label]) => (
            <button key={v} className={(a.after ?? 'repeat') === v ? 'active' : ''} onClick={() => set({ after: v })}>
              {label}
            </button>
          ))}
        </div>
        {(a.after ?? 'repeat') === 'similar' && <p className="muted small">I brani simili arrivano da internet: servirà la connessione.</p>}
      </div>
      <label className="slider-row">
        <span>Volume {Math.round(a.volume * 100)}%</span>
        <input type="range" min={0.1} max={1} step={0.05} value={a.volume} onChange={(e) => set({ volume: Number(e.target.value) })} />
      </label>
      <label className="slider-row">
        <span>Sale piano piano in {a.fadeSec < 60 ? `${a.fadeSec} s` : `${Math.round(a.fadeSec / 60)} min`}</span>
        <input type="range" min={5} max={300} step={5} value={a.fadeSec} onChange={(e) => set({ fadeSec: Number(e.target.value) })} />
      </label>
      <label className="slider-row">
        <span>Posticipa di {a.snooze} min</span>
        <input type="range" min={1} max={30} step={1} value={a.snooze} onChange={(e) => set({ snooze: Number(e.target.value) })} />
      </label>
      <input placeholder="Nome (facoltativo)" value={a.label} onChange={(e) => set({ label: e.target.value })} />
      <button className="primary" onClick={() => onSave({ ...a, enabled: true })}>
        Salva
      </button>
      {!isNew && (
        <button className="danger" onClick={onDelete}>
          <Trash2 /> Elimina sveglia
        </button>
      )}
    </Sheet>
  )
}

/** the first day the alarm can still ring at its time: today, or tomorrow if that time is gone */
function nextDay(a: Alarm): string {
  const d = new Date()
  if (d.getHours() * 60 + d.getMinutes() >= a.hour * 60 + a.minute) d.setDate(d.getDate() + 1)
  return isoDate(d)
}

/** a month to pick a day from (Monday first); the days already gone can't be picked */
function Calendar({ value, hour, minute, onPick }: { value: string; hour: number; minute: number; onPick: (iso: string) => void }) {
  const [month, setMonth] = useState(() => {
    const d = fromIso(value)
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const now = new Date()
  const first = (month.getDay() + 6) % 7 // blanks before the 1st (Monday = 0)
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const cells: Array<number | null> = [...Array<null>(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)]
  const gone = (day: number) => new Date(month.getFullYear(), month.getMonth(), day, hour, minute).getTime() <= now.getTime()
  const canBack = month.getFullYear() > now.getFullYear() || month.getMonth() > now.getMonth()
  const move = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1))
  return (
    <div className="calendar">
      <div className="cal-head">
        <button className="icon-btn" disabled={!canBack} onClick={() => move(-1)} aria-label="Mese prima">
          <ChevronLeft />
        </button>
        <span>
          {MONTHS[month.getMonth()]} {month.getFullYear()}
        </span>
        <button className="icon-btn" onClick={() => move(1)} aria-label="Mese dopo">
          <ChevronRight />
        </button>
      </div>
      <div className="cal-grid">
        {DAY_NAMES.map((d, i) => (
          <span key={`h${i}`} className="cal-dow">
            {d}
          </span>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <span key={i} />
          const iso = isoDate(new Date(month.getFullYear(), month.getMonth(), day))
          return (
            <button
              key={i}
              className={`cal-day ${iso === value ? 'active' : ''} ${iso === isoDate(now) ? 'today' : ''}`}
              disabled={gone(day)}
              onClick={() => onPick(iso)}
            >
              {day}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** what to wake up with: your library, or any album / artist from search */
function ContentPicker({ onPick, onClose }: { onPick: (c: AlarmContent) => void; onClose: () => void }) {
  const store = useStore()
  const [q, setQ] = useState('')
  const [found, setFound] = useState<AlarmContent[] | null>(null)
  useEffect(() => {
    const text = q.trim()
    if (text.length < 2) return setFound(null)
    let alive = true
    const t = setTimeout(() => {
      void engine.spSearch(text).then(
        (r) =>
          alive &&
          setFound([
            ...r.artists.slice(0, 4).map((x) => ({ kind: 'artist' as const, id: x.uri, name: x.name, image: x.image })),
            ...r.albums.slice(0, 6).map((x) => ({ kind: 'album' as const, id: x.uri, name: `${x.name} · ${x.artists[0] ?? ''}`, image: x.image }))
          ])
      )
    }, 400)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [q])
  const fold = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const songs = q.trim().length >= 2 ? store.songs.filter((s) => fold(s.title).includes(fold(q.trim()))).slice(0, 8) : []
  return (
    <Sheet title="Svegliami con…" onClose={onClose}>
      <div className="search-field">
        <SearchIcon className="search-ico light" />
        <input className="with-ico" placeholder="Cerca un brano, un album o un artista" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {!q.trim() && (
        <>
          <button className="pick-row" onClick={() => onPick({ kind: 'liked', id: '', name: 'Brani che ti piacciono' })}>
            <Heart /> Brani che ti piacciono
          </button>
          <button className="pick-row" onClick={() => onPick({ kind: 'all', id: '', name: 'Tutta la libreria' })}>
            <Music /> Tutta la libreria
          </button>
          {store.playlists.map((p) => (
            <button key={p.id} className="pick-row" onClick={() => onPick({ kind: 'playlist', id: p.id, name: p.name })}>
              <ListMusic /> {p.name}
            </button>
          ))}
        </>
      )}
      {songs.map((s) => (
        <button key={s.id} className="pick-row" onClick={() => onPick({ kind: 'song', id: s.id, name: nameParts(s.title).name })}>
          <SongThumb song={s} size={36} /> {s.title}
        </button>
      ))}
      {found?.map((c) => (
        <button key={c.id} className="pick-row" onClick={() => onPick(c)}>
          {c.image ? <img className={c.kind === 'artist' ? 'round' : ''} src={c.image} alt="" /> : <Music />}
          <span>
            {c.name}
            <span className="muted small"> · {c.kind === 'artist' ? 'artista (brani popolari)' : 'album'}</span>
          </span>
        </button>
      ))}
    </Sheet>
  )
}

/* ------------------------------------------------------------- ringing */

/** over everything while an alarm rings (also over the lock screen); keeps Android's copy of the alarms fresh */
export function AlarmRinging() {
  const store = useStore()
  const [ring, setRing] = useState<AlarmState['ringing']>(null)
  const check = useCallback(() => {
    if (isNative) void Alarms.state().then((s) => setRing(s.ringing)).catch(() => undefined)
  }, [])
  useEffect(() => {
    if (!isNative) return
    check()
    const t = setInterval(check, 3000)
    const h = CapApp.addListener('resume', check)
    return () => {
      clearInterval(t)
      void h.then((x) => x.remove())
    }
  }, [check])
  // once per start: the alarms get the library's current files
  const [synced, setSynced] = useState(false)
  useEffect(() => {
    if (!isNative || synced || !store.ready) return
    setSynced(true)
    void loadAlarms().then((a) => (a.length ? pushAlarms(a, store) : null)).catch(() => undefined)
  }, [store, synced])
  if (!ring) return null
  return (
    <div className="alarm-ringing">
      <AlarmClock className="ring-ico" />
      <div className="ring-time">
        {pad(ring.hour)}:{pad(ring.minute)}
      </div>
      <div className="ring-label">{ring.label || 'Sveglia'}</div>
      <button className="ring-snooze" onClick={() => void Alarms.snooze().then(check)}>
        Posticipa {ring.snooze} min
      </button>
      <button className="ring-stop" onClick={() => void Alarms.stop().then(check)}>
        Stop
      </button>
    </div>
  )
}
