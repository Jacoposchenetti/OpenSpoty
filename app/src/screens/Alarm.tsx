import { App as CapApp } from '@capacitor/app'
import { AlarmClock, BellRing, Heart, ListMusic, Music, Plus, Search as SearchIcon, Shuffle, Timer, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Sheet, SongThumb, Spinner } from '../components/ui'
import { Alarms, DAY_NAMES, daysLabel, inWords, loadAlarms, newAlarm, pad, saveAlarmList, type Alarm, type AlarmContent, type AlarmState } from '../lib/alarms'
import { songsFor } from '../lib/catalog'
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

/** hands Android the alarms with their songs (also on every start: the library changes) */
async function pushAlarms(alarms: Alarm[], store: Store): Promise<AlarmState | null> {
  if (!isNative) return null
  const withSpecs = await Promise.all(
    alarms.map(async (a) => ({ ...a, specs: a.enabled ? (await songsOf(a.content, store).catch(() => [])).map(alarmSpec) : [] }))
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
                <span>{a.label || daysLabel(a.days)}</span>
                <span className="muted small">
                  {a.label ? `${daysLabel(a.days)} · ` : ''}
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
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 15000)
    return () => clearInterval(t)
  }, [])
  const active = pb.sleep.at || pb.sleep.atEnd
  return (
    <section className="card">
      <h2>
        <Timer className="inline-ico" /> Timer di spegnimento
      </h2>
      <p className="muted small">
        {pb.sleep.atEnd
          ? 'La musica si ferma alla fine di questo brano.'
          : pb.sleep.at
            ? `La musica si ferma tra ${Math.max(1, Math.round((pb.sleep.at - Date.now()) / 60000))} minuti.`
            : 'Ferma la musica dopo un po’, per addormentarti ascoltando.'}
      </p>
      <div className="chips wrap">
        {[5, 15, 30, 45, 60, 90].map((m) => (
          <button key={m} onClick={() => pb.setSleep(m)}>
            {m} min
          </button>
        ))}
        <button onClick={() => pb.setSleep(-1)}>Fine brano</button>
        {active ? (
          <button className="danger" onClick={() => pb.setSleep(0)}>
            Annulla
          </button>
        ) : null}
      </div>
    </section>
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
