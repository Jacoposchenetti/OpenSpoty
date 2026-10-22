import { Heart, Pause, Play, SkipForward } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { usePlayback } from '../playback'
import { useStore } from '../store'
import { nameParts } from '../lib/media'
import { SongThumb, Spinner } from './ui'

/* Spotify-style bar above the tabs: what is playing, play/pause, next.
   Tapping it opens the full player with the stem mixer. */
export function MiniPlayer() {
  const store = useStore()
  const pb = usePlayback()
  const bar = useRef<HTMLDivElement>(null)
  const song = pb.now ? store.getSong(pb.now.songId) : null

  useEffect(() => {
    let raf = 0
    const tick = () => {
      if (bar.current && pb.duration > 0) bar.current.style.width = `${Math.min(100, (pb.position() / pb.duration) * 100)}%`
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [pb])

  if (!song) return null
  const sub = pb.error
    ? pb.error
    : pb.loading
      ? 'Caricamento…'
      : pb.now?.fromQueue
        ? 'Dalla coda'
        : pb.now?.contextName || 'In riproduzione'

  return (
    <div className="mini">
      <div className="mini-progress">
        <div ref={bar} />
      </div>
      <button className="mini-main" onClick={() => store.setPlayerOpen(true)} aria-label="Apri il player">
        <SongThumb song={song} size={42} />
        <span className="lib-text">
          <span className="row-title">{nameParts(song.title).name}</span>
          <span className={`row-sub ${pb.error ? 'err' : ''}`}>{pb.error || pb.loading ? sub : nameParts(song.title).artist || sub}</span>
        </span>
      </button>
      <button
        className={`mini-btn heart ${song.liked ? 'on' : ''}`}
        onClick={() => store.updateSong(song.id, song.liked ? { liked: false } : { liked: true, likedAt: Date.now() })}
        aria-label={song.liked ? 'Togli dai preferiti' : 'Aggiungi ai preferiti'}
      >
        <Heart fill={song.liked ? 'currentColor' : 'none'} />
      </button>
      <button className="mini-btn" disabled={pb.loading} onClick={pb.toggle} aria-label={pb.playing ? 'Pausa' : 'Play'}>
        {pb.loading ? <Spinner size={22} /> : pb.playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
      </button>
      <button className="mini-btn" onClick={pb.next} aria-label="Successiva">
        <SkipForward fill="currentColor" />
      </button>
    </div>
  )
}
