import { ChevronDown, Languages, Maximize2, Pause, Play, Share2 } from 'lucide-react'
import { Share } from '@capacitor/share'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useBackHandler } from '../components/ui'
import { engine } from '../lib/engine'
import { errMsg, fmtTime } from '../lib/format'
import { t as tr } from '../lib/i18n'
import { getLyrics, plainLines, type LyricLine } from '../lib/lyrics'
import { nameParts, originalRef, youtubeIdOf } from '../lib/media'
import { firstGap, loadTranscript, transcribeAt, type Transcript } from '../lib/transcript'
import { fileUrl, readCacheJson, writeCacheJson } from '../lib/storage'
import type { Song } from '../lib/types'
import { usePlayback } from '../playback'

/* The lyrics under the player, like Spotify: a card in the cover's colour that
   follows the song (tap a line to jump there), translation in small under each
   line, share, and full screen. A podcast episode gets its transcript here
   (Whisper on the phone, a few minutes ahead of what you hear). */

type Words = { timed: LyricLine[] | null; plain: string[] | null }

function useWords(song: Song): Words | null | 'none' {
  const [w, setW] = useState<Words | null | 'none'>(null)
  useEffect(() => {
    let live = true
    setW(null)
    if (song.episode) return // its transcript instead (useEpisodeWords)
    getLyrics(song)
      .then((l) => {
        if (!live) return
        const timed = l.synced ?? l.aligned ?? null
        const plain = !timed && l.plain ? plainLines(l.plain) : null
        setW(timed?.length || plain?.length ? { timed, plain } : 'none')
      })
      .catch(() => live && setW('none'))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song.id])
  return w
}

const AHEAD = 240 // s of transcript kept ready past what you hear

type Transcribing = { at: number; pct?: number; downloading?: boolean } | null

/** An episode's transcript: loaded if there is one, written on its own while you listen (like Spotify). */
function useEpisodeWords(song: Song) {
  const pb = usePlayback()
  const [t, setT] = useState<Transcript | null>(null)
  const run = true
  const [work, setWork] = useState<Transcribing>(null)
  const [err, setErr] = useState<string | null>(null)
  const tRef = useRef<Transcript | null>(null)
  useEffect(() => {
    if (!song.episode) return
    let live = true
    void loadTranscript(song.id).then((x) => {
      if (!live) return
      tRef.current = x
      setT(x)
    })
    return () => {
      live = false
    }
  }, [song.id, song.episode])
  useEffect(() => {
    const src = originalRef(song)
    if (!run || !t || !src) return
    let alive = true
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
          const next = await transcribeAt(song.id, src, now, gap, (pct, downloading) => setWork({ at: gap, pct, downloading }))
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
  }, [run, t === null, song.id])
  const words: Words | null = useMemo(() => (t?.segs.length ? { timed: t.segs.map((s) => ({ t: s.a, text: s.text })), plain: null } : null), [t])
  return { words, loaded: !!t, work, err }
}

type Tr = { map: Record<string, string> | null; state: 'off' | 'busy' | 'ok' | 'error' | 'same' }

/** your language: the phone's (the app may be in English while you read Italian best) */
const myLanguage = () => (navigator.language || 'it').slice(0, 2).toLowerCase()

/** translations of the lines into your language, kept per song */
function useTranslation(songId: string, texts: string[], on: boolean): Tr {
  const language = myLanguage()
  const [tr, setTr] = useState<Tr>({ map: null, state: 'off' })
  const key = texts.join('\n')
  useEffect(() => {
    if (!on || !texts.length) return setTr({ map: null, state: 'off' })
    let live = true
    const file = `lyrics-tr/${songId}.${language}.v2.json` // v2: lines already in your language are left out
    void (async () => {
      let m = (await readCacheJson<Record<string, string>>(file).catch(() => null)) ?? {}
      const missing = [...new Set(texts.filter((x) => !(x in m)))]
      if (missing.length) {
        if (live) setTr({ map: m, state: 'busy' })
        try {
          const out = await engine.translate(missing, language, true)
          m = { ...m }
          missing.forEach((x, i) => (m[x] = out[i] ?? ''))
          void writeCacheJson(file, m)
        } catch {
          if (live) setTr({ map: m, state: 'error' })
          return
        }
      }
      // nothing changed: the lyrics are already in your language
      if (live) setTr({ map: m, state: texts.some((x) => shown(m, x)) ? 'ok' : 'same' })
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songId, key, on, language])
  return tr
}

const bare = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/** a translation worth showing: not empty, not (nearly) the line itself */
const shown = (map: Record<string, string> | null, line: string) => {
  const x = map?.[line]?.trim()
  return x && bare(x) !== bare(line) ? x : null
}

type Palette = { bg: string; text: string }

/** like Spotify's lyrics: the cover's colour as background, the lines in a light tint of it (the sung one white) */
const palette = (h: number, s: number): Palette => ({
  bg: `hsl(${Math.round(h)} ${Math.round(Math.min(70, Math.max(35, s)))}% 30%)`,
  text: `hsl(${Math.round(h)} ${Math.round(Math.min(75, Math.max(40, s + 10)))}% 72%)`
})

/** the palette from the cover's average colour (from the title if the image can't be read) */
export function useCardColour(song: Song): Palette {
  const [c, setC] = useState(() => fallbackColour(song.title))
  useEffect(() => {
    const vid = youtubeIdOf(song.id)
    const src = (song.cover && fileUrl(song.cover)) || song.art || (vid ? `https://i.ytimg.com/vi/${vid}/mqdefault.jpg` : null)
    setC(fallbackColour(song.title))
    if (!src) return
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const cv = document.createElement('canvas')
        cv.width = cv.height = 8
        const g = cv.getContext('2d')!
        g.drawImage(img, 0, 0, 8, 8)
        const d = g.getImageData(0, 0, 8, 8).data
        let r = 0, gr = 0, b = 0
        for (let i = 0; i < d.length; i += 4) {
          r += d[i]
          gr += d[i + 1]
          b += d[i + 2]
        }
        const n = d.length / 4
        const [h, s] = hsl(r / n, gr / n, b / n)
        setC(palette(h, s * 100))
      } catch {
        /* a cross-origin image: keep the fallback */
      }
    }
    img.src = src
  }, [song.id, song.cover, song.art, song.title])
  return c
}

function fallbackColour(title: string): Palette {
  let h = 0
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) % 360
  return palette(h, 50)
}

function hsl(r: number, g: number, b: number): [number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s]
}

/** the playing position, a few times a second (enough for lines) */
function usePosition(): number {
  const pb = usePlayback()
  const [pos, setPos] = useState(pb.position())
  useEffect(() => {
    const t = setInterval(() => setPos(pb.position()), 200)
    return () => clearInterval(t)
  }, [pb])
  return pos
}

const activeIndex = (lines: LyricLine[], pos: number) => {
  let i = -1
  for (let k = 0; k < lines.length; k++) if (lines[k].t <= pos + 0.15) i = k
  return i
}

async function shareLines(song: Song, lines: string[]) {
  const { name, artist } = nameParts(song.title)
  const text = `${lines.filter(Boolean).join('\n')}\n\n— ${name}${artist ? `, ${artist}` : ''}`
  try {
    await Share.share({ title: name, text })
  } catch {
    /* closed */
  }
}

function TrNote({ state }: { state: Tr['state'] }) {
  if (state === 'busy') return <p className="lyrics-card-note">{tr('Traduco…')}</p>
  if (state === 'error') return <p className="lyrics-card-note">{tr('Traduzione non riuscita: sei online?')}</p>
  if (state === 'same') return <p className="lyrics-card-note">{tr('Il testo è già nella tua lingua.')}</p>
  return null
}

/** an episode without transcript yet: what is being done */
function EpisodeStart({ ep }: { ep: ReturnType<typeof useEpisodeWords> }) {
  if (!ep.loaded) return <p className="lyric past">…</p>
  return <TranscribeNote work={ep.work ?? { at: 0 }} err={ep.err} />
}

function TranscribeNote({ work, err }: { work: Transcribing; err: string | null }) {
  if (err) return <p className="lyrics-card-note">{err}</p>
  if (!work) return null
  return (
    <p className="lyrics-card-note">
      {work.downloading
        ? `${tr('Scarico il riconoscimento della voce (57 MB, una volta sola)')} · ${work.pct ?? 0}%`
        : `${tr('Trascrivo da')} ${fmtTime(work.at)}…`}
    </p>
  )
}

/* ------------------------------------------------------------ the card under the player */

export function LyricsCard({ song }: { song: Song }) {
  const lyrics = useWords(song)
  const ep = useEpisodeWords(song)
  const words = song.episode ? ep.words : lyrics
  const colour = useCardColour(song)
  const [trOn, setTrOn] = useState(false)
  const [full, setFull] = useState(false)
  const pos = usePosition()
  const pb = usePlayback()
  const box = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLElement>(null)
  const texts = useMemo(() => (words && words !== 'none' ? (words.timed?.map((l) => l.text) ?? words.plain ?? []).filter((x) => x.trim()) : []), [words])
  const trans = useTranslation(song.id, texts, trOn)
  const trMap = trans.map
  const timed = words && words !== 'none' ? words.timed : null
  const active = timed ? activeIndex(timed, pos) : -1

  // keep the line being sung near the top of the card
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)
    if (el && box.current) box.current.scrollTo({ top: Math.max(0, el.offsetTop - 12), behavior: 'smooth' })
  }, [active])

  if (words === 'none') return null
  const shareNow = () => {
    if (timed) void shareLines(song, timed.slice(Math.max(0, active), Math.max(0, active) + 4).map((l) => l.text))
    else if (words?.plain) void shareLines(song, words.plain.slice(0, 4))
  }
  return (
    <section ref={card} className="lyrics-card" style={{ background: colour.bg, ['--ly-text' as string]: colour.text }}>
      {/* tapping the card's top scrolls the player down to show it whole */}
      <div className="lyrics-card-head" onClick={(e) => !(e.target as HTMLElement).closest('button') && card.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })}>
        <b>{tr('Testo')}</b>
        <span className="lyrics-card-tools">
          <button className={`round-btn ${trOn ? 'on' : ''}`} onClick={() => setTrOn(!trOn)} aria-label={tr('Traduzione')} disabled={!words}>
            <Languages />
          </button>
          <button className="round-btn" onClick={shareNow} aria-label={tr('Condividi')} disabled={!words}>
            <Share2 />
          </button>
          <button className="round-btn" onClick={() => setFull(true)} aria-label={tr('Schermo intero')} disabled={!words}>
            <Maximize2 />
          </button>
        </span>
      </div>
      <div className="lyrics-card-body" ref={box}>
        {!words && song.episode ? (
          <EpisodeStart ep={ep} />
        ) : !words ? (
          <p className="lyric past">…</p>
        ) : timed ? (
          timed.map((l, i) =>
            l.text.trim() ? (
              <button key={i} data-i={i} className={`lyric ${i === active ? 'now' : i < active ? 'past' : ''}`} onClick={() => pb.seek(l.t)}>
                {l.text}
                {trOn && shown(trMap, l.text) && <small>{shown(trMap, l.text)}</small>}
              </button>
            ) : (
              <span key={i} data-i={i} className={`lyric ${i === active ? 'now' : 'past'}`}>
                ♪
              </span>
            )
          )
        ) : (
          words.plain!.map((x, i) => (
            <p key={i} className="lyric plain">
              {x}
              {trOn && shown(trMap, x) && <small>{shown(trMap, x)}</small>}
            </p>
          ))
        )}
      </div>
      {words && !timed && <p className="lyrics-card-note">{tr('Testo senza tempi: non segue la canzone.')}</p>}
      {song.episode && words && <TranscribeNote work={ep.work} err={ep.err} />}
      <TrNote state={trans.state} />
      {full && words && createPortal(<LyricsFull song={song} words={words} colour={colour} trOn={trOn} setTrOn={setTrOn} trans={trans} onClose={() => setFull(false)} />, document.body)}
    </section>
  )
}

/* ------------------------------------------------------------ full screen */

function LyricsFull({
  song,
  words,
  colour,
  trOn,
  setTrOn,
  trans,
  onClose
}: {
  song: Song
  words: Words
  colour: Palette
  trOn: boolean
  setTrOn: (v: boolean) => void
  trans: Tr
  onClose: () => void
}) {
  const trMap = trans.map
  useBackHandler(onClose)
  const pb = usePlayback()
  const pos = usePosition()
  const box = useRef<HTMLDivElement>(null)
  const timed = words.timed
  const active = timed ? activeIndex(timed, pos) : -1
  const [scrub, setScrub] = useState<number | null>(null)
  const dur = pb.duration
  const { name, artist } = nameParts(song.title)

  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)
    if (el && box.current) box.current.scrollTo({ top: Math.max(0, el.offsetTop - box.current.clientHeight * 0.3), behavior: 'smooth' })
  }, [active])

  const shareNow = () => {
    if (timed) void shareLines(song, timed.slice(Math.max(0, active), Math.max(0, active) + 4).map((l) => l.text))
    else if (words.plain) void shareLines(song, words.plain.slice(0, 4))
  }
  const shownPos = scrub ?? pos
  return (
    <div className="lyrics-full" style={{ background: colour.bg, ['--ly-text' as string]: colour.text }}>
      <header className="lyrics-full-head">
        <button className="icon-btn" onClick={onClose} aria-label={tr('Chiudi')}>
          <ChevronDown />
        </button>
        <span>
          <b>{name}</b>
          <small>{artist}</small>
        </span>
        <span style={{ width: 44 }} />
      </header>
      <div className="lyrics-full-body" ref={box}>
        {timed
          ? timed.map((l, i) =>
              l.text.trim() ? (
                <button key={i} data-i={i} className={`lyric ${i === active ? 'now' : i < active ? 'past' : ''}`} onClick={() => pb.seek(l.t)}>
                  {l.text}
                  {trOn && shown(trMap, l.text) && <small>{shown(trMap, l.text)}</small>}
                </button>
              ) : (
                <span key={i} data-i={i} className={`lyric ${i === active ? 'now' : 'past'}`}>
                  ♪
                </span>
              )
            )
          : words.plain!.map((x, i) => (
              <p key={i} className="lyric plain">
                {x}
                {trOn && shown(trMap, x) && <small>{shown(trMap, x)}</small>}
              </p>
            ))}
      </div>
      <footer className="lyrics-full-foot">
        <TrNote state={trans.state} />
        <div className="lyrics-full-tools">
          <button className={`round-btn ${trOn ? 'on' : ''}`} onClick={() => setTrOn(!trOn)} aria-label={tr('Traduzione')}>
            <Languages />
          </button>
          <button className="round-btn" onClick={shareNow} aria-label={tr('Condividi')}>
            <Share2 />
          </button>
        </div>
        <input
          type="range"
          min={0}
          max={dur || 1}
          step={0.1}
          value={Math.min(shownPos, dur || 1)}
          onChange={(e) => setScrub(Number(e.target.value))}
          onPointerUp={(e) => {
            pb.seek(Number((e.target as HTMLInputElement).value))
            setScrub(null)
          }}
          aria-label={tr('Posizione')}
        />
        <div className="lyrics-full-times">
          <span>{fmtTime(shownPos)}</span>
          <span>-{fmtTime(Math.max(0, dur - shownPos))}</span>
        </div>
        <button className="t-play" onClick={pb.toggle} aria-label={pb.playing ? tr('Pausa') : 'Play'}>
          {pb.playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
        </button>
      </footer>
    </div>
  )
}
