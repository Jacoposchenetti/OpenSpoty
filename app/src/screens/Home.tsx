import { AlarmClock, AudioLines, EllipsisVertical, Guitar, LocateFixed, MapPin, Map as MapIcon, Ticket, Mic2, Pin, PinOff, Users, type LucideIcon } from 'lucide-react'
import {
  concertArtists,
  currentPosition,
  findCity,
  homeCountry,
  mapUrl,
  nearbyConcerts,
  setConcertSettings,
  ticketsUrl,
  useConcertSettings,
  type ConcertSettings,
  type NearConcert
} from '../lib/concerts'
import { setProfile } from '../lib/profile'
import { Sheet } from '../components/ui'
import { localeTag } from '../lib/i18n'
import { useEffect, useMemo, useState } from 'react'
import { SongThumb } from '../components/ui'
import { engine } from '../lib/engine'
import { historySong, loadHistory, type HistoryEntry } from '../lib/history'
import { t } from '../lib/i18n'
import { nameParts } from '../lib/media'
import { togglePin, usePinned, type Tool } from '../lib/pins'
import { useProfile } from '../lib/profile'
import { isNative, StemKitNative } from '../lib/native'
import { usePlayback } from '../playback'
import { useStore } from '../store'
import { JamSheet } from './Jam'

/* Home, like Spotify's: what you played lately (songs, artists, podcasts) and the
   tools (tuner, alarm, identify, Jam), each one can be pinned to the bar below. */

export const TOOLS: Array<{ id: Tool; label: string; sub: string; icon: LucideIcon }> = [
  { id: 'tuner', label: 'Accorda', sub: 'Accordatore per chitarra e basso', icon: Guitar },
  { id: 'alarm', label: 'Sveglia', sub: 'Sveglie e timer di spegnimento', icon: AlarmClock },
  { id: 'capture', label: 'Cattura', sub: 'Riconosci il brano che sta suonando', icon: AudioLines }
]

export function Home() {
  const store = useStore()
  const playback = usePlayback()
  const profile = useProfile()
  const pinned = usePinned()
  const [jamOpen, setJamOpen] = useState(false)
  const concerts = useConcertSettings()
  const [concertOpts, setConcertOpts] = useState(false)
  // re-read when a song starts (the history is written by playback)
  // plus the library's songs played before this history existed
  const history = useMemo(() => {
    const h = loadHistory()
    const seen = new Set(h.map((e) => e.id))
    const older: HistoryEntry[] = store.songs
      .filter((s) => s.playedAt && !seen.has(s.id))
      .map((s) => ({ id: s.id, title: s.title, duration: s.duration, art: s.art, cover: s.cover, artists: s.artists, artistUri: s.artistUri, episode: s.episode, at: s.playedAt! }))
    return [...h, ...older].sort((a, b) => b.at - a.at)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback.now?.songId, store.songs])

  const songs = history.filter((e) => !e.episode).slice(0, 12)
  const podcasts = useMemo(() => {
    const seen = new Set<string>()
    return history.filter((e) => e.episode && !seen.has(e.episode.feed) && seen.add(e.episode.feed)).slice(0, 10)
  }, [history])
  const artists = useMemo(() => recentArtists(history), [history])

  const play = (e: HistoryEntry) => {
    if (!store.getSong(e.id)) store.addTemp([historySong(e)])
    playback.playSong(e.id)
  }
  const hour = new Date().getHours()
  const hello = hour < 5 || hour >= 18 ? t('Buonasera') : hour < 13 ? t('Buongiorno') : t('Buon pomeriggio')

  return (
    <div className="home">
      <h1 className="home-hello">{profile.name ? `${hello}, ${profile.name}` : hello}</h1>

      {songs.length > 0 ? (
        <>
          <div className="q-head">{t('Ascoltati di recente')}</div>
          <div className="recent">
            {songs.map((e) => (
              <button key={e.id} className="recent-item" onClick={() => play(e)}>
                <SongThumb song={store.getSong(e.id) ?? e} size={96} />
                <span className="recent-title">{nameParts(e.title).name}</span>
                <span className="recent-artist">{nameParts(e.title).artist}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="muted small">{t('Quello che ascolti lo ritrovi qui.')}</p>
      )}

      {artists.length > 0 && (
        <>
          <div className="q-head">{t('Artisti ascoltati di recente')}</div>
          <div className="recent">
            {artists.map((a) => (
              <ArtistTile key={a.uri} uri={a.uri} name={a.name} />
            ))}
          </div>
        </>
      )}

      {profile.location || (concerts.useGps && concerts.gps) ? (
        <Concerts city={profile.location} />
      ) : (
        <button className="concert-banner" onClick={() => setConcertOpts(true)}>
          <MapPin />
          <span>
            <b>{t('Concerti vicino a te')}</b>
            <small className="block">
              {t('Dicci dove sei per vedere i concerti dei tuoi artisti.')} <u>{t('Imposta il luogo')}</u>
            </small>
          </span>
        </button>
      )}
      {concertOpts && <ConcertOptions onClose={() => setConcertOpts(false)} />}

      {podcasts.length > 0 && (
        <>
          <div className="q-head">{t('Podcast ascoltati di recente')}</div>
          <div className="recent">
            {podcasts.map((e) => (
              <button key={e.episode!.feed} className="recent-item" onClick={() => store.openPage({ kind: 'podcast', uri: e.episode!.feed, name: e.episode!.podcast })}>
                {e.art ? <img className="thumb" src={e.art} alt="" style={{ width: 96, height: 96 }} loading="lazy" /> : <span className="thumb ph" style={{ width: 96, height: 96 }} />}
                <span className="recent-title">{e.episode!.podcast}</span>
                <span className="recent-artist">Podcast</span>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="q-head">{t('Strumenti')}</div>
      <div className="tools">
        {TOOLS.map((x) => {
          const on = pinned.includes(x.id)
          return (
            <div key={x.id} className="tool">
              <button className="tool-main" onClick={() => store.setTab(x.id)}>
                <x.icon />
                <span className="tool-name">{t(x.label)}</span>
                <span className="tool-sub">{t(x.sub)}</span>
              </button>
              <button className={`tool-pin ${on ? 'on' : ''}`} onClick={() => togglePin(x.id)} aria-label={on ? t('Togli dalla barra') : t('Aggiungi alla barra')}>
                {on ? <PinOff /> : <Pin />}
              </button>
            </div>
          )
        })}
        {isNative && (
          <div className="tool">
            <button className="tool-main" onClick={() => setJamOpen(true)}>
              <Users />
              <span className="tool-name">Jam</span>
              <span className="tool-sub">{t('Ascoltate insieme sullo stesso Wi-Fi')}</span>
            </button>
          </div>
        )}
      </div>
      <p className="muted small">{t('Con la puntina aggiungi uno strumento alla barra in basso.')}</p>
      {jamOpen && <JamSheet onClose={() => setJamOpen(false)} />}
    </div>
  )
}

/** the artists of the songs played lately (those with a Spotify page), most recent first */
function recentArtists(history: HistoryEntry[]): Array<{ uri: string; name: string }> {
  const out: Array<{ uri: string; name: string }> = []
  for (const e of history) {
    if (e.episode) continue
    const list = e.artists?.length ? e.artists : e.artistUri ? [{ name: nameParts(e.title).artist, uri: e.artistUri }] : []
    for (const a of list) {
      if (a.uri && !out.some((x) => x.uri === a.uri)) out.push({ uri: a.uri, name: a.name })
    }
    if (out.length >= 10) break
  }
  return out.slice(0, 10)
}

function ArtistTile({ uri, name }: { uri: string; name: string }) {
  const store = useStore()
  const followed = store.artists.find((a) => a.id === uri)?.image
  const [image, setImage] = useState(followed ?? '')
  useEffect(() => {
    if (followed) return
    let live = true
    engine
      .spArtist(uri)
      .then((a) => live && setImage(a.image))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [uri, followed])
  return (
    <button className="recent-item" onClick={() => store.openPage({ kind: 'artist', uri, name })}>
      {image ? <img className="thumb round" src={image} alt="" style={{ width: 96, height: 96 }} loading="lazy" /> : <span className="thumb ph round" style={{ width: 96, height: 96 }} />}
      <span className="recent-title">{name}</span>
      <span className="recent-artist">{t('Artista')}</span>
    </button>
  )
}

/** "Concerti vicino a te": your artists' concerts near you (its ⋮: where, how near, whose) */
function Concerts({ city }: { city: string }) {
  const store = useStore()
  const cs = useConcertSettings()
  const [list, setList] = useState<NearConcert[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<NearConcert | null>(null)
  const [opts, setOpts] = useState(false)
  // the library changes often; the artists to look at much less
  const libKey = `${store.songs.length}|${store.artists.length}|${store.playlists.length}`
  useEffect(() => {
    let live = true
    setErr(null)
    setList(null)
    const t0 = window.setTimeout(() => {
      concertArtists(cs, store.songs, store.playlists, store.artists)
        .then((artists) => nearbyConcerts(cs, city, artists))
        .then((l) => live && setList(l))
        .catch((e) => live && setErr(e instanceof Error && e.message === 'place' ? 'place' : 'net'))
    }, 400) // the city is typed: not at every letter
    return () => {
      live = false
      clearTimeout(t0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cs, city, libKey])
  const fmt = new Intl.DateTimeFormat(localeTag(), { day: 'numeric', month: 'short' })
  const wd = new Intl.DateTimeFormat(localeTag(), { weekday: 'short', hour: '2-digit', minute: '2-digit' })
  const place = cs.useGps ? cs.gps?.name || t('vicino a te') : city
  const country = useHomeCountry(cs, city)
  const where = cs.wholeCountry && country ? `${place} · ${t('tutto il paese')} (${countryName(country)})` : place
  return (
    <>
      <div className="q-head concerts-head">
        <span>
          {t('Concerti vicino a te')} · {where}
        </span>
        <button className="icon-btn" onClick={() => setOpts(true)} aria-label={t('Impostazioni dei concerti')}>
          <EllipsisVertical />
        </button>
      </div>
      {opts && <ConcertOptions onClose={() => setOpts(false)} />}
      {err === 'place' ? (
        <p className="muted small">
          {t('Non trovo «{place}»: controlla la città nel profilo.', { place: city })}{' '}
          <button className="link" onClick={() => setOpts(true)}>
            {t('Imposta il luogo')}
          </button>
        </p>
      ) : err ? (
        <p className="muted small">{t('Concerti non disponibili ora (sei offline?).')}</p>
      ) : !list ? (
        <p className="muted small">{t('Cerco i concerti dei tuoi artisti…')}</p>
      ) : !list.length ? (
        <p className="muted small">
          {cs.wholeCountry ? t('Nessun concerto dei tuoi artisti nel paese per ora.') : t('Nessun concerto dei tuoi artisti entro {km} km per ora.', { km: cs.radius })}
        </p>
      ) : (
        <div className="recent">
          {list.map((c) => {
            const d = new Date(c.date)
            return (
              <button key={c.uri} className="concert" onClick={() => setOpen(c)}>
                <span className="concert-date">{fmt.format(d)}</span>
                <span className="concert-when">{wd.format(d)}</span>
                <span className="recent-title">{c.artist}</span>
                <span className="recent-artist">
                  {c.city} · {c.venue}
                </span>
                <span className="recent-artist">{c.km < 5 ? t('in città') : `${c.km} km`}</span>
              </button>
            )
          })}
        </div>
      )}
      {open && <ConcertSheet c={open} onClose={() => setOpen(null)} />}
    </>
  )
}

/** under the city: what it was found as, so a typo shows ("Londons" -> Londons, Stati Uniti) */
function FoundCity({ city }: { city: string }) {
  const [found, setFound] = useState<{ name?: string; area?: string; country: string } | null | 'none'>(null)
  useEffect(() => {
    if (!city.trim()) return setFound(null)
    let live = true
    const t0 = window.setTimeout(() => {
      findCity(city)
        .then((p) => live && setFound(p ?? 'none'))
        .catch(() => live && setFound(null))
    }, 500)
    return () => {
      live = false
      clearTimeout(t0)
    }
  }, [city])
  if (!found) return null
  if (found === 'none') return <p className="located">{t('Non trovo questa città: controlla come l’hai scritta.')}</p>
  return (
    <p className="located">
      <MapPin /> {t('Trovata: {place}', { place: [found.name, found.area, countryName(found.country)].filter(Boolean).join(', ') })}
    </p>
  )
}

/** the country of the place the concerts are measured from ('' while unknown) */
function useHomeCountry(cs: ConcertSettings, city: string): string {
  const [c, setC] = useState('')
  useEffect(() => {
    let live = true
    const t0 = window.setTimeout(() => void homeCountry(cs, city).then((x) => live && setC(x)), 400)
    return () => {
      live = false
      clearTimeout(t0)
    }
  }, [cs, city])
  return c
}

/** "IT" -> "Italia" (in the app's language) */
function countryName(code: string): string {
  try {
    return new Intl.DisplayNames([localeTag()], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

/** the ⋮ of "Concerti vicino a te": where, how near, whose concerts */
function ConcertOptions({ onClose }: { onClose: () => void }) {
  const store = useStore()
  const profile = useProfile()
  const cs = useConcertSettings()
  const [city, setCity] = useState(profile.location)
  const [locating, setLocating] = useState<string | null>(null)
  const set = (p: Partial<ConcertSettings>) => setConcertSettings(p)
  const country = useHomeCountry(cs, city)
  const src = (p: Partial<ConcertSettings['sources']>) => set({ sources: { ...cs.sources, ...p } })
  const [off, setOff] = useState(false) // the phone's location is switched off
  const gps = async () => {
    setLocating(t('Cerco la tua posizione…'))
    setOff(false)
    try {
      set({ useGps: true, gps: await currentPosition() })
      setLocating(null)
    } catch (e) {
      set({ useGps: false })
      const m = e instanceof Error ? e.message : ''
      if (m === 'spenta') setOff(true)
      setLocating(
        m === 'permesso'
          ? t('Permesso della posizione negato: puoi scrivere la città.')
          : m === 'spenta'
            ? t('La posizione del telefono è spenta.')
            : t('Posizione non trovata: puoi scrivere la città.')
      )
    }
  }
  // back from the phone's settings with the location on: try again
  useEffect(() => {
    if (!off) return
    const again = () => document.visibilityState === 'visible' && void gps()
    document.addEventListener('visibilitychange', again)
    return () => document.removeEventListener('visibilitychange', again)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [off])
  const toggle = (list: string[], x: string) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x])
  return (
    <Sheet title={t('Concerti vicino a te')} onClose={onClose}>
      <div className="q-head">{t('Dove')}</div>
      <div className="seg">
        <button className={!cs.useGps ? 'active' : ''} onClick={() => set({ useGps: false })}>
          <MapPin /> {t('Una città')}
        </button>
        <button className={cs.useGps ? 'active' : ''} onClick={() => void gps()}>
          <LocateFixed /> {t('La tua posizione')}
        </button>
      </div>
      {!cs.useGps && (
        <>
          <input
            value={city}
            placeholder={t('Città')}
            onChange={(e) => (setCity(e.target.value), setProfile({ location: e.target.value.trim() }))}
          />
          <FoundCity city={city} />
        </>
      )}
      {locating && <p className="muted small">{locating}</p>}
      {off && (
        <button className="primary" onClick={() => void StemKitNative.openLocationSettings()}>
          <LocateFixed /> {t('Attiva la posizione')}
        </button>
      )}
      {cs.useGps && cs.gps && !locating && (
        <p className="located">
          <MapPin />{' '}
          {cs.gps.name ? t('Ti ho trovato a {place}', { place: [cs.gps.name, cs.gps.region].filter(Boolean).join(', ') }) : t('Ti ho trovato (nome del luogo non disponibile)')}
          <button className="link" onClick={() => void gps()}>
            {t('Aggiorna')}
          </button>
        </p>
      )}

      <div className="q-head">{t('Quanto vicino')}</div>
      <label className="radius-row">
        <input type="range" min={10} max={500} step={10} value={cs.radius} onChange={(e) => set({ radius: Number(e.target.value) })} />
        <span>{cs.radius} km</span>
      </label>

      <label className="switch-row">
        <span>
          {country ? t('Tutto il paese ({country})', { country: countryName(country) }) : t('Tutto il paese')}
          <small className="muted block">{t('Anche i concerti lontani, se sono nel paese della tua città o posizione.')}</small>
        </span>
        <input type="checkbox" checked={cs.wholeCountry} onChange={(e) => set({ wholeCountry: e.target.checked })} />
      </label>

      <div className="q-head">{t('Di quali artisti')}</div>
      <p className="muted small">{t('Si sommano: ogni scelta aggiunge i suoi artisti.')}</p>
      {(
        [
          ['followed', t('Artisti che segui')],
          ['library', t('Artisti dei brani in libreria')],
          ['recent', t('Artisti ascoltati di recente')],
          ['suggested', t('Artisti che potrebbero piacerti (dai tuoi ascolti dell’ultimo anno)')]
        ] as const
      ).map(([k, label]) => (
        <label key={k} className="switch-row">
          <span>{label}</span>
          <input type="checkbox" checked={cs.sources[k]} onChange={(e) => src({ [k]: e.target.checked })} />
        </label>
      ))}
      {store.playlists.length > 0 && (
        <>
          <p className="muted small">{t('In più, gli artisti di queste liste:')}</p>
          <div className="chips">
            {store.playlists.map((p) => (
              <button key={p.id} className={cs.sources.playlists.includes(p.id) ? 'active' : ''} onClick={() => src({ playlists: toggle(cs.sources.playlists, p.id) })}>
                {p.name}
              </button>
            ))}
          </div>
        </>
      )}
    </Sheet>
  )
}

function ConcertSheet({ c, onClose }: { c: NearConcert; onClose: () => void }) {
  const store = useStore()
  const when = new Intl.DateTimeFormat(localeTag(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(c.date))
  return (
    <Sheet title={c.title || c.artist} onClose={onClose}>
      <div className="concert-info">
        <span className="concert-when-full">{when}</span>
        <span>
          {c.venue} · {c.city}
        </span>
        <span className="muted small">
          {c.km < 5 ? t('in città') : t('a {km} km da te', { km: c.km })}
          {c.festival ? ` · ${t('Festival')}` : ''}
        </span>
      </div>
      <a className="sheet-link" href={ticketsUrl(c)} target="_blank" rel="noopener noreferrer">
        <Ticket /> {t('Cerca i biglietti')}
      </a>
      <a className="sheet-link" href={mapUrl(c)} target="_blank" rel="noopener noreferrer">
        <MapIcon /> {t('Apri nella mappa')}
      </a>
      <button onClick={() => (onClose(), store.openPage({ kind: 'artist', uri: c.artistUri, name: c.artist }))}>
        <Mic2 /> {t("Vai all'artista")}
      </button>
    </Sheet>
  )
}
