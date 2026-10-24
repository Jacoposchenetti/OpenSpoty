import { ChevronDown, Guitar, Minus, Pause, Play, Plus, RotateCcw, SlidersHorizontal, SlidersVertical, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Sheet, Spinner, useBackHandler } from '../components/ui'
import {
  applyEdits,
  chordName,
  detectKey,
  getChords,
  keyName,
  labelOf,
  layout,
  parse,
  prefersFlats,
  QUALITIES,
  type ChordData,
  type ChordSeg,
  type Display
} from '../lib/chords'
import { errMsg } from '../lib/format'
import { alignLyrics, getLyrics, moveLine, type Lyrics } from '../lib/lyrics'
import { nameParts } from '../lib/media'
import { usePlayback } from '../playback'
import { useStore } from '../store'
import { fmtTime } from '../lib/format'
import { isNative } from '../lib/native'
import { STEM_META, type MixState, type StemId } from '../lib/types'
import { TempoSheet } from './Player'

function pref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(`stemkit:${key}`) ?? fallback
  } catch {
    return fallback
  }
}
function setPref(key: string, v: string) {
  try {
    localStorage.setItem(`stemkit:${key}`, v)
  } catch {
    /* private mode */
  }
}

/* "Suona": everything for playing along in one page. The stems with their
   volumes, speed and key, the A-B loop, and the lyrics (synced, from LRCLIB)
   with the chords over them, recognised from the song itself. */
export function LyricsView({ songId, onClose }: { songId: string; onClose: () => void }) {
  const store = useStore()
  const pb = usePlayback()
  const song = store.getSong(songId)!
  const [lyrics, setLyrics] = useState<Lyrics | null>(null)
  const [showChords, setShowChords] = useState(pref('chords', '0') === '1')
  const [chords, setChords] = useState<ChordData | null>(null)
  const [pct, setPct] = useState<number | null>(null)
  const [chordErr, setChordErr] = useState<string | null>(null)
  const [capo, setCapo] = useState(Number(pref(`capo:${songId}`, '0')) || 0)
  const [simple, setSimple] = useState(pref('chords-simple', '0') === '1')
  const [editing, setEditing] = useState<ChordSeg | null>(null)
  const [showTempo, setShowTempo] = useState(false)
  const [cur, setCur] = useState({ line: -1, chord: -1 })
  const [aligning, setAligning] = useState<{ pct: number; downloading: boolean } | null>(null)
  const [alignErr, setAlignErr] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useBackHandler(onClose)

  const load = (force = false) => {
    setLyrics(null)
    void getLyrics(song, force).then(setLyrics)
  }
  useEffect(() => load(), []) // eslint-disable-line react-hooks/exhaustive-deps

  // lyrics with only the words: their times come from the song (once, then saved)
  const align = (l: Lyrics) => {
    setAlignErr(null)
    setAligning({ pct: 0, downloading: false })
    alignLyrics(song, l, (pct, downloading) => setAligning({ pct, downloading }))
      .then(setLyrics)
      .catch((e) => setAlignErr(errMsg(e)))
      .finally(() => setAligning(null))
  }
  useEffect(() => {
    if (lyrics && !lyrics.synced && lyrics.plain && !lyrics.aligned && !aligning && !alignErr) align(lyrics)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lyrics])
  /** long press on a line while the song plays: it starts here */
  const moveHere = (index: number) => {
    if (!lyrics) return
    const t = pb.position()
    void moveLine(song.id, lyrics, index, t).then((l) => {
      setLyrics(l)
      store.showToast(`Riga spostata a ${fmtTime(t)}`)
    })
  }

  const analyse = (force = false) => {
    setChordErr(null)
    setPct(0)
    getChords(song, setPct, force)
      .then(setChords)
      .catch((e) => setChordErr(errMsg(e)))
      .finally(() => setPct(null))
  }
  useEffect(() => {
    if (showChords && !chords && pct === null && !chordErr) analyse()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showChords])

  const segs = useMemo(() => (chords ? applyEdits(chords.segments, song.chordEdits) : []), [chords, song.chordEdits])
  const key = useMemo(() => (chords ? detectKey(segs, chords.duration) : null), [segs, chords])
  const pitch = Math.round(pb.mix.pitch ?? 0)
  const d: Display = { shift: pitch - capo, flats: prefersFlats(key, pitch), simple }
  const lines = lyrics?.synced ?? lyrics?.aligned
  const blocks = useMemo(() => (showChords && chords && lines?.length ? layout(lines, segs, chords.duration) : null), [showChords, chords, lines, segs])

  // follow the song: the line being sung and the chord being played
  useEffect(() => {
    if (!lines?.length && !segs.length) return
    let raf = 0
    let last = ''
    const tick = () => {
      const t = pb.position() + 0.15
      let line = -1
      if (lines) for (let k = 0; k < lines.length && lines[k].t <= t; k++) line = k
      let chord = -1
      for (let k = 0; k < segs.length && segs[k][0] <= t; k++) chord = k
      const now = `${line}:${chord}`
      if (now !== last) {
        const lineChanged = !last.startsWith(`${line}:`)
        last = now
        setCur({ line, chord })
        if (lineChanged || !lines?.length) {
          const el =
            box.current?.querySelector<HTMLElement>(`[data-i="${Math.max(0, line)}"]`) ??
            box.current?.querySelector<HTMLElement>(`[data-c="${Math.max(0, chord)}"]`)
          el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [lines, segs, pb])

  const toggleChords = () => {
    setShowChords(!showChords)
    setPref('chords', showChords ? '0' : '1')
  }
  const currentChord = segs[cur.chord]
  // the chord playing lights up where it is being played: in the current line (or its own row)
  const chordSpan = (c: ChordSeg, here = true) => (
    <span
      className={`cc ${here && c === currentChord ? 'now' : ''} ${c[2] < 0.45 ? 'unsure' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        setEditing(c)
      }}
    >
      {chordName(c[1], d)}
    </span>
  )
  const { name, artist } = nameParts(song.title)
  const mix = pb.mix
  const update = (next: MixState) => pb.setMix(next)
  const speed = mix.speed ?? 1
  const setSpeed = (v: number) => update({ ...mix, speed: Math.max(0.5, Math.min(1.5, Math.round(v * 100) / 100)) })
  // the key moves the music, and the chords with it
  const setPitch = (v: number) => update({ ...mix, pitch: Math.max(-6, Math.min(6, v)) })

  return (
    <div className="lyrics">
      <header className="player-head">
        <button className="icon-btn" onClick={onClose} aria-label="Chiudi">
          <ChevronDown />
        </button>
        <div className="player-title">
          <div className="title">{name}</div>
          <div className="sub">{artist || (lines ? 'Testo sincronizzato' : 'Testo')}</div>
        </div>
        <button className={`chords-btn ${showChords ? 'on' : ''}`} onClick={toggleChords} aria-label="Accordi">
          <Guitar />
          <small>Accordi</small>
        </button>
      </header>

      <Mixer songId={songId} mix={mix} onChange={update} />

      <div className="chord-bar">
        <span className="stepper-mini">
          <button onClick={() => setSpeed(speed - 0.05)} aria-label="Più lenta">
            <Minus />
          </button>
          <span>Velocità {Math.round(speed * 100)}%</span>
          <button onClick={() => setSpeed(speed + 0.05)} aria-label="Più veloce">
            <Plus />
          </button>
        </span>
        <span className="stepper-mini">
          <button onClick={() => setPitch(pitch - 1)} aria-label="Mezzo tono sotto">
            <Minus />
          </button>
          <span>Tono {pitch > 0 ? `+${pitch}` : pitch || '0'}</span>
          <button onClick={() => setPitch(pitch + 1)} aria-label="Mezzo tono sopra">
            <Plus />
          </button>
        </span>
        <button className="more" onClick={() => setShowTempo(true)} aria-label="BPM e count-in">
          <SlidersHorizontal />
        </button>
        {!isNative && <span className="muted small">velocità e tono: solo sul telefono</span>}
      </div>

      {showChords && chords && (
        <div className="chord-bar">
          {key && <span className="key">{keyName(key, pitch)}</span>}
          <span className="capo">
            <button onClick={() => (setCapo(Math.max(0, capo - 1)), setPref(`capo:${songId}`, String(Math.max(0, capo - 1))))} aria-label="Capotasto giù">
              <Minus />
            </button>
            Capo {capo || 'no'}
            <button onClick={() => (setCapo(Math.min(9, capo + 1)), setPref(`capo:${songId}`, String(Math.min(9, capo + 1))))} aria-label="Capotasto su">
              <Plus />
            </button>
          </span>
          <button className={`simple ${simple ? 'on' : ''}`} onClick={() => (setSimple(!simple), setPref('chords-simple', simple ? '0' : '1'))}>
            Semplici
          </button>
        </div>
      )}

      <div className={`lyrics-body ${showChords ? 'with-chords' : ''}`} ref={box}>
        {showChords && pct !== null && (
          <div className="chord-wait">
            <Spinner size={26} />
            <span>Riconosco gli accordi… {pct}%</span>
            <span className="muted small">Una volta sola per canzone: poi restano salvati.</span>
          </div>
        )}
        {showChords && chordErr && (
          <div className="notice error">
            {chordErr} <button onClick={() => analyse()}>Riprova</button>
          </div>
        )}
        {!lyrics && !showChords && (
          <div className="page-loading">
            <Spinner size={26} />
          </div>
        )}
        {lyrics && !lyrics.found && !(showChords && chords) && (
          <div className="empty">
            <p className="big">Testo non trovato</p>
            <p>LRCLIB non ha questa canzone (o il titolo è scritto in modo diverso).</p>
            <button onClick={() => load(true)}>Riprova</button>
          </div>
        )}

        {blocks
          ? blocks.map((b, k) =>
              b.kind === 'chords' ? (
                <div key={k} className="chord-row" data-c={segs.indexOf(b.chords[0])} onClick={() => pb.seek(b.t)}>
                  {b.chords.map((c, j) => (
                    <span key={j}>{chordSpan(c, !lines?.[cur.line] || lines[cur.line].t <= b.t)}</span>
                  ))}
                </div>
              ) : (
                <button
                  key={k}
                  data-i={b.index}
                  className={`lyric chorded ${b.index === cur.line ? 'now' : b.index < cur.line ? 'past' : ''}`}
                  onClick={() => pb.seek(b.t)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    moveHere(b.index)
                  }}
                >
                  {b.parts.map((p, j) => (
                    <span key={j} className="cp">
                      {p.chord ? chordSpan(p.chord, b.index === cur.line) : <span className="cc empty">{' '}</span>}
                      <span className="ct">{p.text}</span>
                    </span>
                  ))}
                </button>
              )
            )
          : showChords && chords && (
              // no synced lyrics: the chords in time, then the words if there are any
              <div className="chord-sheet">
                {segs
                  .filter((s) => s[1] !== 'N')
                  .map((c) => (
                    <span key={c[0]} data-c={segs.indexOf(c)} onClick={() => pb.seek(c[0])}>
                      {chordSpan(c)}
                    </span>
                  ))}
              </div>
            )}

        {!blocks &&
          lines?.map((l, i) => (
            <button
              key={i}
              data-i={i}
              className={`lyric ${i === cur.line ? 'now' : i < cur.line ? 'past' : ''}`}
              onClick={() => pb.seek(l.t)}
              onContextMenu={(e) => {
                e.preventDefault()
                moveHere(i)
              }}
            >
              {l.text || '♪'}
            </button>
          ))}
        {aligning && (
          <div className="align-note">
            <Spinner size={16} />
            {aligning.downloading
              ? `Scarico il riconoscimento del canto (57 MB, una volta sola) · ${aligning.pct}%`
              : `Metto il testo a tempo con la musica · ${aligning.pct}%`}
          </div>
        )}
        {alignErr && (
          <div className="align-note">
            {alignErr}
            <button className="link-btn small" onClick={() => lyrics && align(lyrics)}>
              Riprova
            </button>
          </div>
        )}
        {lyrics && !lines && lyrics.plain && <pre className="lyrics-plain">{lyrics.plain}</pre>}
        {lyrics?.instrumental && !lines && !lyrics.plain && !showChords && <p className="muted">Brano strumentale.</p>}
        {lyrics?.found && (
          <p className="credits">
            Testi da LRCLIB
            {lyrics.aligned && !lyrics.synced ? ' · tempi ricavati dalla voce' : ''}
            {showChords && chords ? ' · accordi riconosciuti dall’audio: toccane uno per correggerlo' : ''}
            {lines?.length ? ' · una riga fuori tempo? Tienila premuta quando inizia e si sposta lì' : ''}
          </p>
        )}
        {lyrics?.aligned && !lyrics.synced && !aligning && (
          <button className="link-btn small" onClick={() => align({ ...lyrics, aligned: undefined })}>
            <RotateCcw /> Ricalcola i tempi del testo
          </button>
        )}
        {showChords && chords && (
          <button className="link-btn small" onClick={() => analyse(true)}>
            <RotateCcw /> Rianalizza
          </button>
        )}
      </div>

      <PlayBar />
      {showTempo && <TempoSheet song={song} mix={mix} onChange={update} onClose={() => setShowTempo(false)} />}

      {editing && (
        <ChordEditor
          seg={editing}
          d={d}
          onClose={() => setEditing(null)}
          onSave={(label) => {
            const edits = { ...(song.chordEdits ?? {}) }
            if (label === null) delete edits[editing[0].toFixed(2)]
            else edits[editing[0].toFixed(2)] = label
            store.updateSong(song.id, { chordEdits: edits })
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

const QUALITY_NAMES: Record<string, string> = {
  maj: 'maggiore',
  min: 'minore',
  '7': '7',
  maj7: 'maj7',
  min7: 'm7',
  sus4: 'sus4',
  sus2: 'sus2',
  dim: 'dim',
  aug: 'aug',
  maj6: '6',
  min6: 'm6',
  dim7: 'dim7',
  hdim7: 'm7♭5',
  minmaj7: 'm(maj7)'
}

/** fix a chord: root and type as shown (key change and capo included), saved in the original key */
function ChordEditor({ seg, d, onClose, onSave }: { seg: ChordSeg; d: Display; onClose: () => void; onSave: (label: string | null) => void }) {
  const c = parse(seg[1])
  const [root, setRoot] = useState(c ? (((c.root + d.shift) % 12) + 12) % 12 : 0)
  const [quality, setQuality] = useState(c?.quality ?? 'maj')
  const names = d.flats ? ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const label = labelOf(root - d.shift, quality)
  return (
    <Sheet title={`Accordo a ${Math.floor(seg[0] / 60)}:${String(Math.floor(seg[0] % 60)).padStart(2, '0')}`} onClose={onClose}>
      <div className="chord-grid">
        {names.map((n, i) => (
          <button key={n} className={i === root ? 'active' : ''} onClick={() => setRoot(i)}>
            {n}
          </button>
        ))}
      </div>
      <div className="chord-grid q">
        {QUALITIES.map((q) => (
          <button key={q} className={q === quality ? 'active' : ''} onClick={() => setQuality(q)}>
            {QUALITY_NAMES[q]}
          </button>
        ))}
      </div>
      <button className="primary" onClick={() => onSave(label)}>
        Usa {chordName(label, { ...d, simple: false })}
      </button>
      <button onClick={() => onSave('')}>Nessun accordo qui</button>
      <button onClick={() => onSave(null)}>Ripristina quello riconosciuto</button>
    </Sheet>
  )
}

/** voice and instruments, small: tap to mute, slider for the volume, S = solo */
function Mixer({ songId, mix, onChange }: { songId: string; mix: MixState; onChange: (m: MixState) => void }) {
  const store = useStore()
  const song = store.getSong(songId)!
  if (!song.stems.length) {
    const job = store.deviceJob
    return (
      <div className="mixer-empty">
        {job?.state === 'running' && job.songId === song.id ? (
          <span className="muted small">
            <Spinner size={14} /> Separo le tracce… {Math.round(job.pct)}%
          </span>
        ) : (
          <button className="small" onClick={() => void store.splitLater(song)}>
            <SlidersVertical /> Separa voce e strumenti
          </button>
        )}
      </div>
    )
  }
  const audible = (id: StemId) => (mix.solo.length ? mix.solo.includes(id) : !mix.muted.includes(id))
  const toggleMute = (id: StemId) => onChange({ ...mix, muted: mix.muted.includes(id) ? mix.muted.filter((x) => x !== id) : [...mix.muted, id] })
  const toggleSolo = (id: StemId) => onChange({ ...mix, solo: mix.solo.includes(id) ? mix.solo.filter((x) => x !== id) : [...mix.solo, id] })
  return (
    <div className="mixer">
      {song.stems.map((id) => {
        const meta = STEM_META[id]
        const on = audible(id)
        return (
          <div key={id} className={`mx ${on ? 'on' : 'off'}`} style={{ ['--c' as string]: meta.color }}>
            <button className="mx-name" onClick={() => toggleMute(id)} disabled={!!mix.solo.length} aria-label={`${meta.label}: ${on ? 'attiva' : 'silenziata'}`}>
              {meta.label}
            </button>
            <input
              type="range"
              min={0}
              max={1.25}
              step={0.01}
              value={mix.vols[id] ?? 1}
              onChange={(e) => onChange({ ...mix, vols: { ...mix.vols, [id]: Number(e.target.value) } })}
              aria-label={`Volume ${meta.label}`}
            />
            <button className={`mx-solo ${mix.solo.includes(id) ? 'active' : ''}`} onClick={() => toggleSolo(id)} aria-label={`Solo ${meta.label}`}>
              S
            </button>
          </div>
        )
      })}
      <div className="mx-presets">
        <button onClick={() => onChange({ ...mix, muted: [], solo: [], vols: {} })}>Tutte</button>
        {song.stems.includes('vocals') && <button onClick={() => onChange({ ...mix, muted: ['vocals'], solo: [] })}>Senza voce</button>}
      </div>
    </div>
  )
}

/** where the song is, the A-B loop to practise a passage, play/pause */
export function PlayBar() {
  const pb = usePlayback()
  const [pos, setPos] = useState(0)
  const [a, setA] = useState<number | null>(null)
  const [b, setB] = useState<number | null>(null)
  const scrubbing = useRef(false)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      if (!scrubbing.current) setPos(pb.position())
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [pb])
  const ready = !pb.loading && !pb.error
  const loopOn = !!pb.loop
  return (
    <div className="playbar">
      <div className="seek">
        <span>{fmtTime(pos)}</span>
        <input
          type="range"
          min={0}
          max={pb.duration || 1}
          step={0.1}
          value={Math.min(pos, pb.duration)}
          disabled={!ready}
          onPointerDown={() => (scrubbing.current = true)}
          onChange={(e) => setPos(Number(e.target.value))}
          onPointerUp={(e) => {
            scrubbing.current = false
            pb.seek(Number((e.target as HTMLInputElement).value))
          }}
          aria-label="Posizione"
        />
        <span>{fmtTime(pb.duration)}</span>
      </div>
      <div className="playbar-row">
        <button className={a !== null ? 'set' : ''} onClick={() => setA(pos)} disabled={!ready}>
          A {a !== null ? fmtTime(a) : ''}
        </button>
        <button className={b !== null ? 'set' : ''} onClick={() => setB(pos)} disabled={!ready}>
          B {b !== null ? fmtTime(b) : ''}
        </button>
        <button className={loopOn ? 'active' : ''} disabled={a === null || b === null || b <= a} onClick={() => pb.setLoop(loopOn ? null : { a: a!, b: b! })}>
          Loop
        </button>
        {(a !== null || b !== null) && (
          <button onClick={() => (pb.setLoop(null), setA(null), setB(null))} aria-label="Cancella loop">
            <X />
          </button>
        )}
        <button className="pb-play" disabled={!ready && !pb.loading} onClick={pb.toggle} aria-label={pb.playing ? 'Pausa' : 'Play'}>
          {pb.loading ? <Spinner size={24} /> : pb.playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
        </button>
      </div>
    </div>
  )
}
