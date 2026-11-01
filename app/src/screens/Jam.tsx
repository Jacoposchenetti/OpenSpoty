import { ArrowDown, ArrowUp, Copy, Pause, Play, Plus, Search as SearchIcon, Share2, SkipBack, SkipForward, Users, X, Check } from 'lucide-react'
import qrcode from 'qrcode-generator'
import { useEffect, useMemo, useState } from 'react'
import { Share } from '@capacitor/share'
import { Capacitor } from '@capacitor/core'
import { Sheet, Spinner } from '../components/ui'
import { engine, type SpTrack } from '../lib/engine'
import { fmtTime, errMsg } from '../lib/format'
import { t as tr } from '../lib/i18n'
import { JamClient, jamName, joinedJam, setJoinedJam, parseJamLink, refreshJam, setJamName, startJam, stopJam, useHostedJam, type FoundJam, type JamItem, type JamNow, type JamState } from '../lib/jam'
import { StemPlayer } from '../lib/player'
import { useStore } from '../store'

/* Jam, like Spotify's (lib/jam.ts): start one (QR and link for friends, the
   shared queue), or join a friend's, found on the Wi-Fi or from its link. */

export function JamSheet({ onClose }: { onClose: () => void }) {
  const hosted = useHostedJam()
  const [joined, setJoined] = useState(joinedJam)
  const join = (url: string | null) => {
    setJoinedJam(url)
    setJoined(url)
  }
  return (
    <Sheet title="Jam" onClose={onClose}>
      {hosted.active ? <HostView jam={hosted} /> : joined ? <GuestView url={joined} onLeave={() => join(null)} /> : <StartView onJoin={join} />}
    </Sheet>
  )
}

/* ------------------------------------------------------------ start or join */

function StartView({ onJoin }: { onJoin: (url: string) => void }) {
  const store = useStore()
  const [name, setName] = useState(jamName)
  const [control, setControl] = useState(true)
  const [busy, setBusy] = useState(false)
  const [found, setFound] = useState<FoundJam[]>([])
  const [link, setLink] = useState('')
  useEffect(() => {
    const h = StemPlayer.addListener('player', (e) => {
      if (e.type === 'jamFound' && e.name && e.url) setFound((f) => [...f.filter((x) => x.name !== e.name), { name: e.name!, url: e.url! }])
      if (e.type === 'jamLost' && e.name) setFound((f) => f.filter((x) => x.name !== e.name))
    })
    void StemPlayer.jamDiscover({ on: true })
    return () => {
      void StemPlayer.jamDiscover({ on: false })
      void h.then((x) => x.remove())
    }
  }, [])
  const start = async () => {
    setBusy(true)
    try {
      setJamName(name.trim())
      await startJam(name.trim() || 'OpenSpoty', control)
    } catch (e) {
      store.showToast(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  const pasted = parseJamLink(link)
  return (
    <div className="jam">
      <p className="muted small">{tr('Ascoltate insieme: gli amici sullo stesso Wi-Fi aggiungono brani a una coda comune, che suona su questo telefono.')}</p>
      {jamName() ? (
        <p className="muted small">{tr('Partecipi come {name} (dal tuo profilo).', { name: jamName() })}</p>
      ) : (
        <label className="field">
          <span>{tr('Il tuo nome')}</span>
          <input value={name} maxLength={30} placeholder="OpenSpoty" onChange={(e) => setName(e.target.value)} />
        </label>
      )}
      <label className="switch-row">
        <span>
          {tr('Gli ospiti possono controllare')}
          <small className="muted block">{tr('Pausa, salta, riordina e togli brani dalla coda. Senza, possono solo aggiungere (e togliere i propri).')}</small>
        </span>
        <input type="checkbox" checked={control} onChange={(e) => setControl(e.target.checked)} />
      </label>
      <button className="primary jam-start" disabled={busy} onClick={() => void start()}>
        {busy ? <Spinner /> : <Users />} {tr('Avvia una Jam')}
      </button>

      <div className="q-head">{tr('Unisciti a una Jam')}</div>
      {found.length ? (
        found.map((f) => (
          <button key={f.url} className="q-row" onClick={() => onJoin(f.url)}>
            <span className="jam-ico">
              <Users />
            </span>
            <span className="pick-title">{f.name}</span>
            <span className="pill">{tr('Unisciti')}</span>
          </button>
        ))
      ) : (
        <p className="muted small">
          <Spinner /> {tr('Cerco Jam su questo Wi-Fi…')}
        </p>
      )}
      <div className="jam-link">
        <input value={link} placeholder={tr('Oppure incolla il link della Jam')} onChange={(e) => setLink(e.target.value)} />
        <button disabled={!pasted} onClick={() => pasted && onJoin(pasted)}>
          {tr('Unisciti')}
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ hosting */

/** artwork as the engine has it: a file on this phone, or an address */
const localArt = (a: string) => (a.startsWith('/') ? Capacitor.convertFileSrc(`file://${a}`) : a)

function HostView({ jam }: { jam: JamState }) {
  const store = useStore()
  const url = jam.url ?? ''
  const svg = useMemo(() => {
    const q = qrcode(0, 'M')
    q.addData(url)
    q.make()
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
  }, [url])
  const [ending, setEnding] = useState(false)
  useEffect(() => {
    const t = setInterval(() => void refreshJam(), 2000)
    return () => clearInterval(t)
  }, [])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      store.showToast(tr('Link copiato'))
    } catch {
      void Share.share({ url })
    }
  }
  const edit = (key: string, action: 'remove' | 'up' | 'down') => void StemPlayer.jamEdit({ key, action })
  const q = jam.queue ?? []
  return (
    <div className="jam">
      <p className="muted small center">{tr('Gli amici sullo stesso Wi-Fi inquadrano il codice (si apre nel browser, senza app) oppure ti trovano da OpenSpoty.')}</p>
      <div className="jam-qr" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="jam-actions">
        <button onClick={() => void copy()}>
          <Copy /> {tr('Copia link')}
        </button>
        <button onClick={() => void Share.share({ title: tr('Unisciti alla mia Jam'), url })}>
          <Share2 /> {tr('Condividi')}
        </button>
      </div>
      <label className="switch-row">
        <span>{tr('Gli ospiti possono controllare')}</span>
        <input type="checkbox" checked={!!jam.allowControl} onChange={(e) => void StemPlayer.jamSetControl({ allowControl: e.target.checked })} />
      </label>
      <div className="q-head">
        {tr('Nella Jam')} ({(jam.guests?.length ?? 0) + 1})
      </div>
      <div className="jam-people">
        <span className="me">{jam.host}</span>
        {(jam.guests ?? []).map((g) => (
          <span key={g}>{g}</span>
        ))}
      </div>
      <NowCard now={jam.now} art={localArt} />
      <div className="q-head">{tr('Coda della Jam')}</div>
      <QueueList items={q} canEdit={() => true} onEdit={edit} art={localArt} host={jam.host ?? ''} />
      <p className="muted small">{tr('Per aggiungere i tuoi brani: ⋮ → “Aggiungi alla Jam”. “Metti in coda” resta la tua coda, che suona quando quella della Jam è finita.')}</p>
      {ending ? (
        <div className="jam-actions">
          <button className="danger" onClick={() => void stopJam()}>
            {tr('Sì, termina')}
          </button>
          <button onClick={() => setEnding(false)}>{tr('Annulla')}</button>
        </div>
      ) : (
        <button className="danger jam-start" onClick={() => setEnding(true)}>
          {tr('Termina la Jam')}
        </button>
      )}
    </div>
  )
}

/* ------------------------------------------------------------ as a guest */

function GuestView({ url, onLeave }: { url: string; onLeave: () => void }) {
  const store = useStore()
  const [who, setWho] = useState(jamName)
  const [named, setNamed] = useState(!!jamName())
  const client = useMemo(() => new JamClient(url, who || 'Ospite'), [url, who])
  const [st, setSt] = useState<JamState | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SpTrack[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [adding, setAdding] = useState<Record<string, 'busy' | 'ok'>>({})

  useEffect(() => {
    if (!named) return
    let live = true
    const tick = () =>
      client
        .state()
        .then((s) => live && (setSt(s), setErr(null)))
        .catch((e) => live && setErr(errMsg(e)))
    void tick()
    const t = setInterval(tick, 2000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [client, named])

  if (!named) {
    return (
      <div className="jam">
        <p className="muted small">{tr('Come ti chiami? Gli altri vedranno chi ha aggiunto ogni brano.')}</p>
        <label className="field">
          <span>{tr('Il tuo nome')}</span>
          <input value={who} maxLength={30} onChange={(e) => setWho(e.target.value)} autoFocus />
        </label>
        <div className="jam-actions">
          <button className="primary" disabled={!who.trim()} onClick={() => (setJamName(who.trim()), setNamed(true))}>
            {tr('Entra')}
          </button>
          <button onClick={onLeave}>{tr('Annulla')}</button>
        </div>
      </div>
    )
  }
  if (err && !st) {
    return (
      <div className="jam">
        <p className="muted">{tr('Non riesco a raggiungere la Jam: sei sullo stesso Wi-Fi?')}</p>
        <p className="muted small">{err}</p>
        <button onClick={onLeave}>{tr('Esci')}</button>
      </div>
    )
  }
  if (!st)
    return (
      <div className="page-loading">
        <Spinner size={26} />
      </div>
    )
  if (!st.active) {
    return (
      <div className="jam">
        <p>{tr('La Jam è finita.')}</p>
        <button onClick={onLeave}>{tr('Esci')}</button>
      </div>
    )
  }
  const search = async () => {
    const q = query.trim()
    if (!q) return
    setSearching(true)
    try {
      setResults((await engine.spSearch(q)).tracks)
    } catch (e) {
      store.showToast(errMsg(e))
    } finally {
      setSearching(false)
    }
  }
  const add = async (t: SpTrack) => {
    setAdding((a) => ({ ...a, [t.uri]: 'busy' }))
    try {
      await client.add({ title: t.title, artists: t.artists, duration: t.duration, image: t.image })
      setAdding((a) => ({ ...a, [t.uri]: 'ok' }))
      store.showToast(tr('Aggiunto alla Jam: {name}', { name: t.title }))
      setSt(await client.state())
    } catch (e) {
      setAdding((a) => {
        const { [t.uri]: _, ...rest } = a
        return rest
      })
      store.showToast(errMsg(e))
    }
  }
  const control = async (action: 'play' | 'pause' | 'next' | 'prev' | 'remove' | 'up' | 'down', key?: string) => {
    try {
      await client.control(action, key)
      setSt(await client.state())
    } catch (e) {
      store.showToast(errMsg(e))
    }
  }
  const ctl = !!st.allowControl
  const now = st.now
  return (
    <div className="jam">
      <div className="jam-guest-head">
        <span>
          <b>{tr('Jam di {name}', { name: st.host ?? '' })}</b>
          <small className="muted block">{tr('Sei dentro come {name} · la musica suona sul suo telefono', { name: client.who })}</small>
        </span>
        <button onClick={onLeave}>{tr('Esci')}</button>
      </div>
      <NowCard now={now} art={(a) => client.art(a, now?.songId ?? null)} />
      {ctl && now?.songId && (
        <div className="jam-ctrl">
          <button className="icon-btn" onClick={() => void control('prev')} aria-label={tr('Precedente')}>
            <SkipBack />
          </button>
          <button className="icon-btn big" onClick={() => void control(now.playing ? 'pause' : 'play')} aria-label={now.playing ? tr('Pausa') : 'Play'}>
            {now.playing ? <Pause /> : <Play />}
          </button>
          <button className="icon-btn" onClick={() => void control('next')} aria-label={tr('Successivo')}>
            <SkipForward />
          </button>
        </div>
      )}
      <div className="q-head">{tr('Aggiungi un brano')}</div>
      <form
        className="jam-link"
        onSubmit={(e) => {
          e.preventDefault()
          void search()
        }}
      >
        <input value={query} placeholder={tr('Cerca brani o artisti')} onChange={(e) => setQuery(e.target.value)} />
        <button type="submit" aria-label={tr('Cerca')}>
          <SearchIcon />
        </button>
      </form>
      {searching && <Spinner />}
      {results?.map((t) => (
        <div key={t.uri} className="q-row">
          {t.image ? <img className="thumb" src={t.image} alt="" style={{ width: 40, height: 40 }} loading="lazy" /> : <span className="thumb ph" style={{ width: 40, height: 40 }} />}
          <span className="pick-title">
            {t.title}
            <small className="muted block">
              {t.artists.join(', ')} · {fmtTime(t.duration)}
            </small>
          </span>
          <button className="icon-btn" disabled={!!adding[t.uri]} onClick={() => void add(t)} aria-label={tr('Aggiungi alla Jam')}>
            {adding[t.uri] === 'busy' ? <Spinner /> : adding[t.uri] === 'ok' ? <Check /> : <Plus />}
          </button>
        </div>
      ))}
      {results && !results.length && <p className="muted small">{tr('Nessun risultato.')}</p>}
      <div className="q-head">{tr('Coda della Jam')}</div>
      <QueueList
        items={st.queue ?? []}
        canEdit={(it) => ctl || it.by === client.who}
        onEdit={(key, action) => void control(action, key)}
        art={(a, id) => client.art(a, id)}
        host={st.host ?? ''}
        reorder={ctl}
      />
    </div>
  )
}

/* ------------------------------------------------------------ shared pieces */

function NowCard({ now, art }: { now?: JamNow; art: (a: string) => string }) {
  if (!now?.songId) return <p className="muted small">{tr('Non suona ancora niente: aggiungi il primo brano!')}</p>
  const pct = now.dur ? Math.min(100, (now.pos / now.dur) * 100) : 0
  return (
    <div className="jam-now">
      {now.art ? <img src={art(now.art)} alt="" /> : <span className="thumb ph" />}
      <span className="jam-now-text">
        <b>{now.name || now.title}</b>
        <small className="muted block">{now.artist}</small>
        <span className="jam-bar">
          <i style={{ width: `${pct}%` }} />
        </span>
      </span>
    </div>
  )
}

function QueueList({
  items,
  canEdit,
  onEdit,
  art,
  host,
  reorder = true
}: {
  items: JamItem[]
  canEdit: (it: JamItem) => boolean
  onEdit: (key: string, action: 'remove' | 'up' | 'down') => void
  art: (a: string, songId: string) => string
  host: string
  reorder?: boolean
}) {
  if (!items.length) return <p className="muted small">{tr('La coda è vuota.')}</p>
  return (
    <>
      {items.map((it, i) => (
        <div key={it.key} className="q-row">
          {it.art ? <img className="thumb" src={art(it.art, it.songId)} alt="" style={{ width: 40, height: 40 }} loading="lazy" /> : <span className="thumb ph" style={{ width: 40, height: 40 }} />}
          <span className="pick-title">
            {it.name || it.title}
            <small className="muted block">
              {it.artist ? `${it.artist} · ` : ''}
              {tr('da {name}', { name: it.by || host })}
            </small>
          </span>
          {reorder && canEdit(it) && (
            <>
              <button className="icon-btn" disabled={i === 0} onClick={() => onEdit(it.key, 'up')} aria-label={tr('Sposta su')}>
                <ArrowUp />
              </button>
              <button className="icon-btn" disabled={i === items.length - 1} onClick={() => onEdit(it.key, 'down')} aria-label={tr('Sposta giù')}>
                <ArrowDown />
              </button>
            </>
          )}
          {canEdit(it) && (
            <button className="icon-btn" onClick={() => onEdit(it.key, 'remove')} aria-label={tr('Togli dalla coda')}>
              <X />
            </button>
          )}
        </div>
      ))}
    </>
  )
}
