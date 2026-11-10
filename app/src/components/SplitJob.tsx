import { Play, SlidersVertical } from 'lucide-react'
import { engine } from '../lib/engine'
import { t as tr } from '../lib/i18n'
import { usePlayback } from '../playback'
import { useStore } from '../store'

/* The separation running on the phone ("Separa le tracce"): shown where you are
   (over the mini player, and in the player), not only in Cerca. */

export function SplitJob({ compact = false }: { compact?: boolean }) {
  const store = useStore()
  const playback = usePlayback()
  const job = store.deviceJob!
  const running = job.state === 'running'
  const queue = job.queue ?? []
  return (
    <section className={`card split-job ${compact ? 'compact' : ''}`}>
      <div className={`job ${job.state}`}>
        <div className="job-title">
          <SlidersVertical /> {job.title ?? tr('Canzone')}
        </div>
        <div className="bar">
          <i style={{ width: `${job.pct}%` }} />
        </div>
        <div className="job-msg">
          {job.state === 'failed' ? tr(job.error || job.message) : tr(job.message)} {running ? `${Math.round(job.pct)}%` : ''}
        </div>
        {queue.length > 0 && (
          <div className="job-msg">
            {tr('In coda')} ({queue.length}): {queue.join(' · ')}
          </div>
        )}
        <div className="row-actions">
          {running ? (
            <>
              <button className="small" onClick={() => void engine.cancelSeparation()}>
                {tr('Annulla')}
              </button>
              {queue.length > 0 && (
                <button className="small" onClick={() => void engine.cancelSeparation(true)}>
                  {tr('Annulla tutto')}
                </button>
              )}
            </>
          ) : (
            <>
              {job.state === 'done' && (
                <button className="small primary" onClick={() => playback.playSong(job.songId)}>
                  <Play fill="currentColor" /> {tr('Play')}
                </button>
              )}
              <button className="small" onClick={() => store.setDeviceJob(null)}>
                {tr('OK')}
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
