import { engine } from './engine'
import { isLocalPath, originalRef } from './media'
import { readCacheJson, writeCacheJson } from './storage'
import type { Song } from './types'

/* Chords recognised from the audio (core/ChordRecognizer.java: BTC, a neural
   network for chord recognition), then laid out over the synced lyrics like
   Ultimate Guitar: transposable, with capo, editable. */

/** [start seconds, "A:min7" (BTC label; N = no chord), confidence 0..1] */
export type ChordSeg = [number, string, number]

export interface ChordData {
  version: number
  duration: number
  segments: ChordSeg[]
}

const file = (id: string) => `chords/${id}.json`

/** the audio the chords are read from: the whole song, or its stems without voice and drums */
function sources(song: Song): string[] {
  const orig = originalRef(song)
  if (orig) return [orig]
  const harmonic = song.stems.filter((s) => s !== 'vocals' && s !== 'drums').map((s) => song.files[s])
  return harmonic.filter(isLocalPath)
}

export async function getChords(song: Song, onProgress: (pct: number) => void, force = false): Promise<ChordData> {
  if (!force) {
    const cached = await readCacheJson<ChordData>(file(song.id))
    if (cached?.segments?.length) return cached
  }
  const paths = sources(song)
  if (!paths.length) throw new Error('Nessun audio per questa canzone')
  const data = await engine.chords(song.id, paths, onProgress)
  await writeCacheJson(file(song.id), data)
  return data
}

// ------------------------------------------------------------ names

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
const IT = ['Do', 'Do#', 'Re', 'Mib', 'Mi', 'Fa', 'Fa#', 'Sol', 'Lab', 'La', 'Sib', 'Si']

export const QUALITIES = ['maj', 'min', '7', 'maj7', 'min7', 'sus4', 'sus2', 'dim', 'aug', 'maj6', 'min6', 'dim7', 'hdim7', 'minmaj7']
const SUFFIX: Record<string, string> = {
  maj: '',
  min: 'm',
  dim: 'dim',
  aug: 'aug',
  min6: 'm6',
  maj6: '6',
  min7: 'm7',
  minmaj7: 'm(maj7)',
  maj7: 'maj7',
  '7': '7',
  dim7: 'dim7',
  hdim7: 'm7♭5',
  sus2: 'sus2',
  sus4: 'sus4'
}
// "only the basic chords": what a beginner plays instead
const SIMPLE: Record<string, string> = { min6: 'min', min7: 'min', minmaj7: 'min', hdim7: 'dim', dim7: 'dim', maj6: 'maj', maj7: 'maj', sus2: 'maj', sus4: 'maj' }

export function parse(label: string): { root: number; quality: string } | null {
  if (label === 'N' || label === 'X' || !label) return null
  const [r, q = 'maj'] = label.split(':')
  const root = SHARP.indexOf(r)
  return root < 0 ? null : { root, quality: q }
}

export const labelOf = (root: number, quality: string) => SHARP[((root % 12) + 12) % 12] + (quality === 'maj' ? '' : `:${quality}`)

export interface Display {
  shift: number // semitones to add (key change minus capo)
  flats: boolean
  simple: boolean
}

export function chordName(label: string, d: Display): string {
  const c = parse(label)
  if (!c) return ''
  const q = d.simple ? SIMPLE[c.quality] ?? (c.quality === '7' ? '7' : c.quality) : c.quality
  return (d.flats ? FLAT : SHARP)[(((c.root + d.shift) % 12) + 12) % 12] + (SUFFIX[q] ?? '')
}

/** the key: the major key whose chords cover most of the song (and its relative minor) */
export function detectKey(segs: ChordSeg[], duration: number): { tonic: number; minor: boolean } | null {
  const dur = new Array(24).fill(0)
  segs.forEach(([t, label], i) => {
    const c = parse(label)
    if (!c) return
    const len = (segs[i + 1]?.[0] ?? duration) - t
    dur[c.root * 2 + (c.quality.startsWith('min') || c.quality.includes('dim') ? 1 : 0)] += len
  })
  let best = -1, bestScore = 0
  for (let k = 0; k < 12; k++) {
    // I, ii, iii, IV, V, vi (and V7 counted as V)
    const s = dur[k * 2] * 1.2 + dur[((k + 2) % 12) * 2 + 1] + dur[((k + 4) % 12) * 2 + 1] + dur[((k + 5) % 12) * 2] + dur[((k + 7) % 12) * 2] + dur[((k + 9) % 12) * 2 + 1]
    if (s > bestScore) {
      bestScore = s
      best = k
    }
  }
  if (best < 0) return null
  // minor if the relative minor chord sounds more than the major tonic
  const rel = (best + 9) % 12
  return dur[rel * 2 + 1] > dur[best * 2] * 1.3 ? { tonic: rel, minor: true } : { tonic: best, minor: false }
}

/** flats in F, Bb, Eb, Ab, Db (and their minors); sharps elsewhere */
export const prefersFlats = (k: { tonic: number; minor: boolean } | null, shift: number) => {
  if (!k) return false
  const major = (((k.minor ? k.tonic + 3 : k.tonic) + shift) % 12 + 12) % 12
  return [5, 10, 3, 8, 1].includes(major)
}

export const keyName = (k: { tonic: number; minor: boolean }, shift: number, language: 'it' | 'en' = 'it') => {
  const index = (((k.tonic + shift) % 12) + 12) % 12
  const note = language === 'it' ? IT[index] : (prefersFlats(k, shift) ? FLAT : SHARP)[index]
  const quality = language === 'it' ? (k.minor ? 'minore' : 'maggiore') : (k.minor ? 'minor' : 'major')
  return `${note} ${quality}`
}

/** user corrections (Song.chordEdits) over the recognised chords; drops repeats and silence */
export function applyEdits(segs: ChordSeg[], edits?: Record<string, string>): ChordSeg[] {
  const out: ChordSeg[] = []
  for (const s of segs) {
    const key = s[0].toFixed(2)
    const label = edits && key in edits ? edits[key] : s[1]
    if (!label || label === 'X') continue
    const prev = out[out.length - 1]
    if (prev && prev[1] === label) continue
    out.push([s[0], label, edits && key in edits ? 1 : s[2]])
  }
  return out
}

// ------------------------------------------------------------ layout over the lyrics

export interface Part {
  chord?: ChordSeg
  text: string
}

export type Block =
  | { kind: 'line'; index: number; t: number; parts: Part[] }
  | { kind: 'chords'; t: number; chords: ChordSeg[] }

/**
 * Each chord goes over the word being sung when it starts. Lines only give
 * their start time: a line is taken to last until the next one, or about as
 * long as it takes to sing it if a long pause follows (an instrumental part,
 * whose chords get a row of their own).
 */
export function layout(lines: Array<{ t: number; text: string }>, segs: ChordSeg[], duration: number): Block[] {
  const chords = segs.filter((s) => s[1] !== 'N')
  const blocks: Block[] = []
  const used = new Set<ChordSeg>()
  const between = (from: number, to: number) => chords.filter((c) => c[0] >= from && c[0] < to && !used.has(c))
  const firstT = lines[0]?.t ?? duration
  const intro = between(0, firstT - 0.4)
  intro.forEach((c) => used.add(c))
  if (intro.length) blocks.push({ kind: 'chords', t: intro[0][0], chords: intro })
  lines.forEach((line, i) => {
    const next = lines[i + 1]?.t ?? duration
    const text = line.text || '♪'
    const end = Math.min(next, line.t + Math.max(2, Math.min(9, text.length * 0.11)))
    // short pause after the line: its chords still belong to it
    const mine = between(line.t - 0.4, next - end >= 3 ? end : next - 0.4)
    mine.forEach((c) => used.add(c))
    // the chord still sounding when the line starts goes over its first word
    const carried = [...chords].reverse().find((c) => c[0] < line.t - 0.4)
    const marks: Array<{ pos: number; chord: ChordSeg }> = []
    const span = Math.max(0.5, end - line.t)
    for (const c of mine) {
      let pos = Math.round(((c[0] - line.t) / span) * text.length)
      pos = Math.max(0, Math.min(text.length - 1, pos))
      while (pos > 0 && text[pos - 1] !== ' ') pos-- // start of that word
      const last = marks[marks.length - 1]
      if (last && pos <= last.pos) {
        // two chords on one word: the second moves to the next word, or after the line
        const nextWord = text.indexOf(' ', last.pos + 1)
        pos = nextWord < 0 ? text.length : nextWord + 1
      }
      marks.push({ pos, chord: c })
    }
    if (carried && (!marks.length || marks[0].pos > 0)) marks.unshift({ pos: 0, chord: carried })
    const parts: Part[] = []
    if (!marks.length || marks[0].pos > 0) parts.push({ text: text.slice(0, marks[0]?.pos ?? text.length) })
    marks.forEach((m, k) => parts.push({ chord: m.chord, text: text.slice(m.pos, marks[k + 1]?.pos ?? text.length) }))
    blocks.push({ kind: 'line', index: i, t: line.t, parts })
    // a pause long enough to be an instrumental part gets its chords on a row of their own;
    // in a short breath they wait for the next line
    if (next - end >= 3) {
      const gap = between(end, next - 0.4)
      gap.forEach((c) => used.add(c))
      if (gap.length) blocks.push({ kind: 'chords', t: gap[0][0], chords: gap })
    }
  })
  return blocks
}
