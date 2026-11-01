import { AlarmClock, AudioLines, Guitar, Pin, PinOff, Users, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { SongThumb } from '../components/ui'
import { engine } from '../lib/engine'
import { historySong, loadHistory, type HistoryEntry } from '../lib/history'
import { t } from '../lib/i18n'
import { nameParts } from '../lib/media'
import { isNative } from '../lib/native'
import { togglePin, usePinned, type Tool } from '../lib/pins'
import { useProfile } from '../lib/profile'
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
