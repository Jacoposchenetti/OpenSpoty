import { ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Spinner, useBackHandler } from '../components/ui'
import { errMsg, fmtTime } from '../lib/format'
import { nameParts, originalRef } from '../lib/media'
import { firstGap, LANGS, loadTranscript, transcribeAt, translateMissing, translated, type Transcript } from '../lib/transcript'
import { usePlayback } from '../playback'
import { useStore } from '../store'
import { t as tr } from '../lib/i18n'
import { PlayBar } from './Lyrics'

/* "Testo" of a podcast episode: what is being said, in time, in its language
   or translated. Written a few minutes ahead while you listen. */

const AHEAD = 240 // s of transcript kept ready past what you hear

export function TranscriptView({ songId, onClose }: { songId: string; onClose: () => void }) {
  const store = useStore()
  const pb = usePlayback()
  const song = store.getSong(songId)!
  const [t, setT] = useState<Transcript | null>(null)
  const [lang, setLang] = useState(() => localStorage.getItem('stemkit:transcript-lang') ?? '')
  const [work, setWork] = useState<{ at: number; pct?: number; downloading?: boolean } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [cur, setCur] = useState(-1)
  const tRef = useRef<Transcript | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useBackHandler(onClose)
  useEffect(() => {
    void loadTranscript(songId).then((x) => {
      tRef.current = x
      setT(x)
    })
  }, [songId])

  // keep the transcript a few minutes ahead of what plays (and wherever you jump)
  useEffect(() => {
    if (!t) return
    let alive = true
    const src = originalRef(song)
    if (!src) return
    void (async () => {
      while (alive) {
        const now = tRef.current!
        const p = pb.position()
        const gap = firstGap(now, p - 2, p + AHEAD)
        if (gap === null) {
          await new Promise((r) => setTimeout(r, 2000))
          continue
        }
        setWork({ at: gap })
        try {
          const next = await transcribeAt(songId, src, now, gap, (pct, downloading) => setWork({ at: gap, pct, downloading }))
          if (!alive) return
          tRef.current = next
          setT(next)
          setErr(null)
        } catch (e) {
          if (!alive) return
          setErr(errMsg(e))
          await new Promise((r) => setTimeout(r, 8000))
        }
      }
    })().finally(() => setWork(null))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t === null, songId])

  // translations follow the transcript
  const shown = lang || t?.lang || ''
  useEffect(() => {
    if (!t || !shown || shown === t.lang || !t.segs.length) return
    let alive = true
    translateMissing(songId, t, shown)
      .then((x) => {
        if (!alive || x === t) return
        tRef.current = { ...tRef.current!, tr: x.tr }
        setT(tRef.current)
      })
      .catch((e) => alive && setErr(errMsg(e)))
    return () => {
      alive = false
    }
  }, [t, shown, songId])

  // the sentence being said, kept in the middle
  useEffect(() => {
    if (!t?.segs.length) return
    let raf = 0
    let last = -2
    const tick = () => {
      const p = pb.position() + 0.2
      let i = -1
      for (let k = 0; k < t.segs.length && t.segs[k].a <= p; k++) i = k
      if (i !== last) {
        last = i
        setCur(i)
        box.current?.querySelector<HTMLElement>(`[data-i="${Math.max(0, i)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [t, pb])

  const pick = (l: string) => {
    setLang(l)
    try {
      localStorage.setItem('stemkit:transcript-lang', l)
    } catch {
      /* private mode */
    }
  }
  const { name, artist } = nameParts(song.title)
  const original = LANGS.find(([k]) => k === t?.lang)?.[1] ?? t?.lang ?? ''
  return (
    <div className="lyrics transcript">
      <header className="player-head">
        <button className="icon-btn" onClick={onClose} aria-label={tr('Chiudi')}>
          <ChevronDown />
        </button>
        <div className="player-title">
          <div className="title">{name}</div>
          <div className="sub">{artist}</div>
        </div>
      </header>
      <div className="lang-chips">
        <button className={!lang || lang === t?.lang ? 'active' : ''} onClick={() => pick('')}>
          {tr('Originale')}{original ? ` (${original})` : ''}
        </button>
        {LANGS.filter(([k]) => k !== t?.lang).map(([k, label]) => (
          <button key={k} className={lang === k ? 'active' : ''} onClick={() => pick(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="lyrics-body" ref={box}>
        {!t && (
          <div className="page-loading">
            <Spinner size={24} />
          </div>
        )}
        {t?.segs.map((s, i) => (
          <button key={s.a} data-i={i} className={`lyric ${i === cur ? 'now' : i < cur ? 'past' : ''}`} onClick={() => pb.seek(s.a)}>
            {translated(t, shown, s)}
          </button>
        ))}
        {work && (
          <div className="align-note">
            <Spinner size={16} />
            {work.downloading
              ? `${tr('Scarico il riconoscimento della voce (57 MB, una volta sola)')} · ${work.pct ?? 0}%`
              : `${tr('Trascrivo da')} ${fmtTime(work.at)}…`}
          </div>
        )}
        {err && <div className="align-note">{err}</div>}
        {t && <p className="credits">{tr('Testo trascritto dall’audio con Whisper')}{shown !== t.lang ? ` · ${tr('tradotto con Google Traduttore')}` : ''}{tr(': può contenere errori.')}</p>}
      </div>
      <PlayBar />
    </div>
  )
}
