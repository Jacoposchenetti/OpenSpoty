import { Check, ChevronLeft, CircleArrowDown, Download, Play } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Spinner } from '../components/ui'
import { errMsg } from '../lib/format'
import { isNative } from '../lib/native'
import {
  downloadEpisode,
  episodeSong,
  isEpisodeDownloaded,
  longTime,
  podcastFeed,
  podcastKey,
  progressOf,
  shortDate,
  type Episode,
  type PodcastFeed
} from '../lib/podcasts'
import { addRecent } from '../lib/recents'
import { usePlayback } from '../playback'
import { useStore } from '../store'
import { t as tr } from '../lib/i18n'

/* A podcast like on Spotify: its picture, Segui, what it is about, and the
   episodes newest first, each with how much of it you heard. */

export function PodcastPage({ feed }: { feed: string }) {
  const store = useStore()
  const pb = usePlayback()
  const [p, setP] = useState<PodcastFeed | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [shown, setShown] = useState(30)
  const [more, setMore] = useState(false)
  const [, bump] = useState(0)
  useEffect(() => {
    podcastFeed(feed)
      .then((x) => {
        setP(x)
        addRecent({ kind: 'podcast', id: feed, title: x.name, sub: 'Podcast', image: x.image })
      })
      .catch((e) => setErr(errMsg(e)))
  }, [feed])
  // the progress bars follow what plays
  useEffect(() => {
    const t = setInterval(() => bump((x) => x + 1), 5000)
    return () => clearInterval(t)
  }, [])
  const songs = useMemo(() => (p ? p.episodes.map((e) => episodeSong(e, p)) : []), [p])

  const top = (
    <div className="list-top">
              <button className="icon-btn back" onClick={store.closePage} aria-label={tr('Indietro')}>
        <ChevronLeft />
      </button>
    </div>
  )
  if (err)
    return (
      <div className="lib catalog">
        {top}
        <p className="notice error">{err}</p>
      </div>
    )
  if (!p)
    return (
      <div className="lib catalog">
        {top}
        <div className="page-loading">
          <Spinner size={26} />
        </div>
      </div>
    )
  const key = podcastKey(feed)
  const following = store.isFollowing(key)
  const play = (i: number) => {
    store.addTemp(songs)
    pb.playList(
      songs.map((s) => s.id),
      i,
      'Podcast'
    )
  }
  return (
    <div className="lib catalog podcast-page">
      {top}
      <div className="pod-head">
        {p.image && <img src={p.image} alt="" />}
        <h1>{p.name}</h1>
        <span className="muted">{p.author}</span>
        <div className="pod-actions">
          <button
            className={`follow-btn ${following ? 'on' : ''}`}
            onClick={() => {
              store.toggleFollow({ uri: key, name: p.name, image: p.image })
              store.showToast(following ? `${tr('Non segui più')} ${p.name}` : `${tr('Ora segui')} ${p.name}`)
            }}
          >
            {following ? tr('Segui già') : tr('Segui')}
          </button>
          <button className="primary pod-play" disabled={!songs.length} onClick={() => play(0)} aria-label={tr("Ascolta l'ultimo episodio")}>
            <Play fill="currentColor" />
          </button>
        </div>
        {p.description && (
          <p className={`pod-desc ${more ? 'open' : ''}`} onClick={() => setMore(!more)}>
            {p.description}
          </p>
        )}
      </div>
      <h3 className="sec">{tr('Episodi')}</h3>
      {p.episodes.slice(0, shown).map((e, i) => (
        <EpisodeRow key={e.guid} e={e} p={p} current={pb.now?.songId === songs[i]?.id} onPlay={() => play(i)} />
      ))}
      {p.episodes.length > shown && (
        <button className="link-btn" onClick={() => setShown(shown + 30)}>
          {tr('Mostra altri episodi')}
        </button>
      )}
    </div>
  )
}

function EpisodeRow({ e, p, current, onPlay }: { e: Episode; p: PodcastFeed; current: boolean; onPlay: () => void }) {
  const store = useStore()
  const song = episodeSong(e, p)
  const prog = progressOf(song.id)
  const [busy, setBusy] = useState(false)
  const [have, setHave] = useState(() => isEpisodeDownloaded(song.id))
  const left = prog && !prog.done ? Math.max(0, e.duration - prog.frac * e.duration) : e.duration
  return (
    <div className={`episode ${current ? 'current' : ''}`}>
      <button className="ep-main" onClick={onPlay}>
        <span className="row-title">{e.title}</span>
        <span className="row-sub">
          {shortDate(e.date)}
          {e.duration ? ` · ${prog?.done ? tr('Ascoltato') : prog ? `${tr('mancano')} ${longTime(left)}` : longTime(e.duration)}` : ''}
        </span>
        {prog && !prog.done && (
          <span className="ep-bar">
            <span style={{ width: `${Math.round(prog.frac * 100)}%` }} />
          </span>
        )}
      </button>
      {prog?.done && <Check className="in-lib-mark" aria-label={tr('Ascoltato')} />}
      {isNative && (
        <button
          className="icon-btn"
          disabled={busy || have}
          onClick={() => {
            setBusy(true)
            downloadEpisode(song, e.url)
              .then(() => {
                setHave(true)
                store.showToast(tr('Episodio scaricato: si ascolta anche offline'))
              })
              .catch((x) => store.showToast(errMsg(x)))
              .finally(() => setBusy(false))
          }}
          aria-label={have ? tr('Scaricato') : tr('Scarica')}
        >
          {busy ? <Spinner size={16} /> : have ? <CircleArrowDown className="dl-mark" /> : <Download />}
        </button>
      )}
    </div>
  )
}

/** "Nuovi episodi" in Cerca: the latest of the podcasts you follow */
export function NewEpisodes() {
  const store = useStore()
  const pb = usePlayback()
  const [list, setList] = useState<Array<{ e: Episode; p: PodcastFeed }> | null>(null)
  const feeds = store.podcasts.map((x) => x.feed).join('|')
  useEffect(() => {
    if (!feeds) return setList(null)
    let alive = true
    void Promise.all(feeds.split('|').map((f) => podcastFeed(f).catch(() => null))).then((all) => {
      if (!alive) return
      const eps = all.flatMap((p) => (p ? p.episodes.slice(0, 2).map((e) => ({ e, p })) : []))
      setList(eps.sort((a, b) => b.e.date - a.e.date).slice(0, 8))
    })
    return () => {
      alive = false
    }
  }, [feeds])
  if (!list?.length) return null
  return (
    <section className="shelf">
      <h3>{tr('Nuovi episodi')}</h3>
      <div className="shelf-row">
        {list.map(({ e, p }) => {
          const s = episodeSong(e, p)
          const prog = progressOf(s.id)
          return (
            <button
              key={s.id}
              className="card-tile"
              onClick={() => {
                store.addTemp([s])
                pb.playList([s.id], 0, tr('Nuovi episodi'))
              }}
            >
              {e.image || p.image ? <img src={e.image || p.image} alt="" loading="lazy" /> : <span className="tile-ph" />}
              <span className="tile-title">{e.title}</span>
              <span className="tile-sub">
                {p.name} · {prog?.done ? tr('Ascoltato') : shortDate(e.date)}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
