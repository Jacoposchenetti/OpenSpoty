import { ChevronLeft, ChevronRight, Guitar, Piano } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Sheet } from '../components/ui'
import { t } from '../lib/i18n'
import { guitarShapes, pianoVoicings, type Shape } from '../lib/voicings'

/* Tapping a chord in Suona: how to play it — every guitar shape (‹ ›, "3 di 26"),
   or the piano keys (root position and inversions); the button below switches. */

const INSTR_KEY = 'stemkit:chord-instrument'
const STRINGS = ['E', 'A', 'D', 'G', 'B', 'E']

export function ChordDiagramSheet({ name, root, quality, capo, onClose }: { name: string; root: number; quality: string; capo: number; onClose: () => void }) {
  const [instr, setInstr] = useState<'guitar' | 'piano'>(() => {
    try {
      return localStorage.getItem(INSTR_KEY) === 'piano' ? 'piano' : 'guitar'
    } catch {
      return 'guitar'
    }
  })
  const shapes = useMemo(() => guitarShapes(root, quality), [root, quality])
  const keys = useMemo(() => pianoVoicings(root, quality), [root, quality])
  const [i, setI] = useState(0)
  const n = instr === 'guitar' ? shapes.length : keys.length
  const k = Math.min(i, Math.max(0, n - 1))
  const switchTo = (x: 'guitar' | 'piano') => {
    setInstr(x)
    setI(0)
    try {
      localStorage.setItem(INSTR_KEY, x)
    } catch {
      /* private mode */
    }
  }
  return (
    <Sheet onClose={onClose}>
      <div className="chord-sheet-view">
        <div className="chord-big">{name}</div>
        <div className="chord-nav">
          <button className="icon-btn" disabled={k <= 0} onClick={() => setI(k - 1)} aria-label={t('Precedente')}>
            <ChevronLeft />
          </button>
          {instr === 'guitar' ? shapes[k] ? <GuitarDiagram shape={shapes[k]} /> : <p className="muted">{t('Nessuna forma trovata')}</p> : <PianoDiagram notes={keys[k]} />}
          <button className="icon-btn" disabled={k >= n - 1} onClick={() => setI(k + 1)} aria-label={t('Successiva')}>
            <ChevronRight />
          </button>
        </div>
        <div className="muted small">
          {n ? t('{i} di {n}', { i: k + 1, n }) : ''}
          {instr === 'piano' ? ` · ${k === 0 ? t('posizione fondamentale') : t('{n}° rivolto', { n: k })}` : ''}
          {instr === 'guitar' && capo > 0 ? ` · ${t('con capotasto al {n}° tasto', { n: capo })}` : ''}
        </div>
        <button className="primary chord-switch" onClick={() => switchTo(instr === 'guitar' ? 'piano' : 'guitar')}>
          {instr === 'guitar' ? <Piano /> : <Guitar />} {instr === 'guitar' ? t('Mostra sul piano') : t('Mostra sulla chitarra')}
        </button>
      </div>
    </Sheet>
  )
}

/** the fretboard: 5 frets from where the shape sits, dots with the fingers, a barre, O / X above */
function GuitarDiagram({ shape }: { shape: Shape }) {
  const pressed = shape.frets.filter((f) => f > 0)
  const top = pressed.length && Math.max(...pressed) > 5 ? Math.min(...pressed) : 1
  const W = 200
  const H = 240
  const x0 = 30
  const y0 = 46
  const gap = (W - 2 * x0) / 5
  const fh = 36
  const sx = (s: number) => x0 + s * gap
  return (
    <svg className="guitar-diagram" viewBox={`0 0 ${W} ${H}`} role="img">
      {/* the nut, or where the shape starts */}
      {top === 1 ? <rect x={x0 - 2} y={y0 - 6} width={W - 2 * x0 + 4} height={6} className="nut" /> : <text x={W - x0 + 8} y={y0 + fh / 2 + 5} className="fret-num">{top}</text>}
      {[0, 1, 2, 3, 4, 5].map((f) => (
        <line key={`f${f}`} x1={x0} x2={W - x0} y1={y0 + f * fh} y2={y0 + f * fh} className="fret" />
      ))}
      {STRINGS.map((_, s) => (
        <line key={`s${s}`} x1={sx(s)} x2={sx(s)} y1={y0} y2={y0 + 5 * fh} className="string" />
      ))}
      {shape.frets.map((f, s) =>
        f < 0 ? (
          <text key={`m${s}`} x={sx(s)} y={y0 - 14} className="mark">
            ×
          </text>
        ) : f === 0 ? (
          <circle key={`o${s}`} cx={sx(s)} cy={y0 - 20} r={8} className="open" />
        ) : null
      )}
      {shape.barre && shape.barre.to > shape.barre.from && (
        <rect
          x={sx(shape.barre.from) - 13}
          y={y0 + (shape.barre.fret - top + 0.5) * fh - 13}
          width={sx(shape.barre.to) - sx(shape.barre.from) + 26}
          height={26}
          rx={13}
          className="dot"
        />
      )}
      {shape.frets.map((f, s) =>
        f > 0 ? (
          <g key={`d${s}`}>
            <circle cx={sx(s)} cy={y0 + (f - top + 0.5) * fh} r={13} className="dot" />
            <text x={sx(s)} y={y0 + (f - top + 0.5) * fh + 5} className="finger">
              {shape.fingers[s] || ''}
            </text>
          </g>
        ) : null
      )}
      {STRINGS.map((name, s) => (
        <text key={`n${s}`} x={sx(s)} y={H - 6} className="string-name">
          {name}
        </text>
      ))}
    </svg>
  )
}

/** two octaves of keys, the chord's lit */
function PianoDiagram({ notes }: { notes: number[] }) {
  const from = 48 // C3
  const whites: number[] = []
  const blacks: number[] = []
  for (let m = from; m < from + 36; m++) ([1, 3, 6, 8, 10].includes(m % 12) ? blacks : whites).push(m)
  const ww = 14
  const W = whites.length * ww
  const H = 90
  const xOfWhite = (m: number) => whites.indexOf(m) * ww
  const on = (m: number) => notes.includes(m)
  return (
    <svg className="piano-diagram" viewBox={`0 0 ${W} ${H}`} role="img">
      {whites.map((m) => (
        <rect key={m} x={xOfWhite(m)} y={0} width={ww} height={H} className={`wkey ${on(m) ? 'on' : ''}`} />
      ))}
      {blacks.map((m) => (
        <rect key={m} x={xOfWhite(m - 1) + ww - 4.5} y={0} width={9} height={H * 0.6} className={`bkey ${on(m) ? 'on' : ''}`} />
      ))}
      {notes.map((m) =>
        whites.includes(m) ? <circle key={`c${m}`} cx={xOfWhite(m) + ww / 2} cy={H - 12} r={4} className="kdot" /> : null
      )}
    </svg>
  )
}
