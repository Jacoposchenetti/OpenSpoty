import { Mic, MicOff, Minus, Plus, Volume2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { detectPitch, freqOf, midiFromName, midiOf, noteIt, noteName, TUNINGS } from '../lib/pitch'
import { usePlayback } from '../playback'

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

interface Reading {
  freq: number
  midi: number // fractional
}

/* "Accordatore": listens to the microphone and shows how far the string is
   from its note (lib/pitch.ts, McLeod pitch method). Works the same on the
   phone and on the PC. */
export function TunerPage() {
  const pb = usePlayback()
  const [tuningId, setTuningId] = useState(pref('tuning', 'std'))
  const [a4, setA4] = useState(Number(pref('a4', '440')) || 440)
  const [locked, setLocked] = useState<number | null>(null) // a string chosen by hand
  const [reading, setReading] = useState<Reading | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [on, setOn] = useState(true)
  const tuning = TUNINGS.find((t) => t.id === tuningId) ?? TUNINGS[0]
  const strings = useMemo(() => tuning.strings.map(midiFromName), [tuning])
  const history = useRef<number[]>([])
  const a4Ref = useRef(a4)
  a4Ref.current = a4

  // the music would be heard by the microphone: it pauses while tuning
  useEffect(() => {
    if (pb.playing) pb.toggle()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!on) return
    let stopped = false
    let cleanup = () => undefined as void
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
        if (stopped) return stream.getTracks().forEach((t) => t.stop())
        const ctx = new AudioContext()
        const src = ctx.createMediaStreamSource(stream)
        const proc = ctx.createScriptProcessor(2048, 1, 1)
        // analysed at ~24 kHz: enough for any string, and fast
        const step = Math.max(1, Math.round(ctx.sampleRate / 24000))
        const rate = ctx.sampleRate / step
        const win = new Float32Array(2048)
        let filled = 0
        let quiet = 0
        proc.onaudioprocess = (e) => {
          const d = e.inputBuffer.getChannelData(0)
          const n = Math.floor(d.length / step)
          win.copyWithin(0, n)
          for (let i = 0; i < n; i++) {
            let s = 0
            for (let k = 0; k < step; k++) s += d[i * step + k]
            win[win.length - n + i] = s / step
          }
          filled = Math.min(win.length, filled + n)
          if (filled < win.length) return
          const p = detectPitch(win, rate, 28, 1500)
          if (!p || p.clarity < 0.88) {
            // a few silent windows in a row: the needle rests
            if (++quiet > 12) {
              history.current = []
              setReading(null)
            }
            return
          }
          quiet = 0
          // median of the last readings: steady needle, no jumps on the attack
          const h = history.current
          h.push(p.freq)
          if (h.length > 5) h.shift()
          const freq = [...h].sort((x, y) => x - y)[Math.floor(h.length / 2)]
          setReading({ freq, midi: midiOf(freq, a4Ref.current) })
        }
        src.connect(proc)
        proc.connect(ctx.destination)
        cleanup = () => {
          proc.disconnect()
          src.disconnect()
          stream.getTracks().forEach((t) => t.stop())
          void ctx.close()
        }
      } catch (e) {
        setErr(/Permission|NotAllowed/i.test(String(e)) ? 'Serve il permesso del microfono per accordare.' : String(e))
        setOn(false)
      }
    })()
    return () => {
      stopped = true
      cleanup()
    }
  }, [on])

  // the target: the string you chose, else the closest string of the tuning, else the closest note
  const target = reading
    ? locked !== null
      ? strings[locked]
      : strings.length
        ? strings.reduce((best, s) => (Math.abs(s - reading.midi) < Math.abs(best - reading.midi) ? s : best), strings[0])
        : Math.round(reading.midi)
    : locked !== null
      ? strings[locked]
      : null
  const cents = reading && target !== null ? Math.max(-50, Math.min(50, (reading.midi - target) * 100)) : 0
  const inTune = reading && Math.abs(cents) < 5
  const activeString = target !== null && strings.length ? strings.indexOf(target) : -1

  const playRef = (midi: number) => {
    const ctx = new AudioContext()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = 'triangle'
    o.frequency.value = freqOf(midi, a4)
    g.gain.setValueAtTime(0.0001, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 2)
    o.connect(g).connect(ctx.destination)
    o.start()
    o.stop(ctx.currentTime + 2.1)
    o.onended = () => void ctx.close()
  }

  return (
    <div className="page flat tuner-page">
      <select
        className="tuning-select"
        value={tuningId}
        onChange={(e) => (setTuningId(e.target.value), setPref('tuning', e.target.value), setLocked(null))}
        aria-label="Accordatura"
      >
        {TUNINGS.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>

      <div className={`tuner-display ${inTune ? 'good' : reading ? 'off' : ''}`}>
        <div className="tuner-note">
          {target !== null ? noteName(target).replace(/-?\d+$/, '') : '–'}
          <span className="tuner-octave">{target !== null ? noteName(target).match(/-?\d+$/)?.[0] : ''}</span>
        </div>
        <div className="tuner-it">{target !== null ? noteIt(target) : 'Suona una corda'}</div>
        <div className="gauge">
          {[-50, -25, 0, 25, 50].map((c) => (
            <span key={c} className={`tick ${c === 0 ? 'zero' : ''}`} style={{ left: `${50 + c}%` }} />
          ))}
          <span className="needle" style={{ left: `${50 + cents}%`, opacity: reading ? 1 : 0.25 }} />
        </div>
        <div className="tuner-hint">
          {!reading
            ? on
              ? 'In ascolto…'
              : ''
            : inTune
              ? 'Accordata ✓'
              : cents < 0
                ? `Troppo bassa · ${Math.round(-cents)} cent: tendi la corda`
                : `Troppo alta · ${Math.round(cents)} cent: allenta la corda`}
        </div>
        {reading && <div className="tuner-freq">{reading.freq.toFixed(1)} Hz</div>}
      </div>

      {strings.length > 0 && (
        <div className="strings">
          {strings.map((m, i) => (
            <button
              key={i}
              className={`string ${activeString === i ? 'active' : ''} ${locked === i ? 'locked' : ''}`}
              onClick={() => (setLocked(locked === i ? null : i), playRef(m))}
              aria-label={`Corda ${noteName(m)}`}
            >
              {noteName(m).replace(/-?\d+$/, '')}
              <small>{noteIt(m)}</small>
            </button>
          ))}
        </div>
      )}
      {strings.length > 0 && (
        <p className="muted small center">
          <Volume2 className="inline-ico" /> Tocca una corda per sentirne la nota e accordare solo quella; tocca di nuovo per tornare automatico.
        </p>
      )}

      <div className="tuner-bottom">
        <span className="stepper-mini">
          <button onClick={() => (setA4(a4 - 1), setPref('a4', String(a4 - 1)))} aria-label="La più basso">
            <Minus />
          </button>
          <span>La = {a4} Hz</span>
          <button onClick={() => (setA4(a4 + 1), setPref('a4', String(a4 + 1)))} aria-label="La più alto">
            <Plus />
          </button>
        </span>
        <button className="small" onClick={() => (setErr(null), setOn(!on))}>
          {on ? <MicOff /> : <Mic />} {on ? 'Ferma' : 'Ascolta'}
        </button>
      </div>
      {err && <div className="notice error">{err}</div>}
    </div>
  )
}
