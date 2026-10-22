/* Pitch of a plucked string, for the tuner: McLeod Pitch Method (normalised
   square difference + the first peak above 0.9 of the highest one, refined
   with a parabola). Works on a 24 kHz mono window of ~85 ms. */

export interface Pitch {
  freq: number
  clarity: number // 0..1: how much the window is a single clean note
}

export function detectPitch(x: Float32Array, rate: number, minHz = 30, maxHz = 1400): Pitch | null {
  const n = x.length
  const minLag = Math.max(2, Math.floor(rate / maxHz))
  const maxLag = Math.min(n - 2, Math.ceil(rate / minHz))
  let energy = 0
  for (let i = 0; i < n; i++) energy += x[i] * x[i]
  if (energy / n < 1e-6) return null // silence
  const nsdf = new Float32Array(maxLag + 2)
  // m(tau) = sum x[i]^2 + x[i+tau]^2, updated incrementally
  let m = 2 * energy
  for (let tau = 0; tau <= maxLag + 1; tau++) {
    if (tau > 0) m -= x[tau - 1] * x[tau - 1] + x[n - tau] * x[n - tau]
    if (tau < minLag) continue
    let r = 0
    for (let i = 0; i + tau < n; i++) r += x[i] * x[i + tau]
    nsdf[tau] = m > 0 ? (2 * r) / m : 0
  }
  // key maxima: the highest point of each positive lobe
  const peaks: number[] = []
  let tau = minLag
  while (tau < maxLag && nsdf[tau] > 0) tau++ // skip the lobe around lag 0
  for (; tau < maxLag; tau++) {
    if (nsdf[tau] <= 0) continue
    let best = tau
    while (tau < maxLag && nsdf[tau] > 0) {
      if (nsdf[tau] > nsdf[best]) best = tau
      tau++
    }
    peaks.push(best)
  }
  if (!peaks.length) return null
  const top = Math.max(...peaks.map((p) => nsdf[p]))
  const pick = peaks.find((p) => nsdf[p] >= 0.9 * top)!
  const a = nsdf[pick - 1], b = nsdf[pick], c = nsdf[pick + 1]
  const shift = (a - c) / (2 * (a - 2 * b + c) || 1)
  const lag = pick + (Number.isFinite(shift) ? shift : 0)
  return { freq: rate / lag, clarity: b }
}

/* ------------------------------------------------------------- notes */

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const IT = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si']

/** MIDI note number (A4 = 69) of a frequency, fractional */
export const midiOf = (freq: number, a4 = 440) => 69 + 12 * Math.log2(freq / a4)
export const freqOf = (midi: number, a4 = 440) => a4 * Math.pow(2, (midi - 69) / 12)
export const noteName = (midi: number) => `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
export const noteIt = (midi: number) => IT[((midi % 12) + 12) % 12]

/** "E2" → 40 */
export function midiFromName(name: string): number {
  const m = name.match(/^([A-G])(#|b)?(-?\d)$/)
  if (!m) return 0
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1] as 'C']
  return base + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12
}

export interface Tuning {
  id: string
  name: string
  strings: string[] // low to high
}

export const TUNINGS: Tuning[] = [
  { id: 'std', name: 'Chitarra · standard', strings: ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'] },
  { id: 'dropd', name: 'Chitarra · Drop D', strings: ['D2', 'A2', 'D3', 'G3', 'B3', 'E4'] },
  { id: 'half', name: 'Chitarra · mezzo tono sotto', strings: ['Eb2', 'Ab2', 'Db3', 'Gb3', 'Bb3', 'Eb4'] },
  { id: 'dadgad', name: 'Chitarra · DADGAD', strings: ['D2', 'A2', 'D3', 'G3', 'A3', 'D4'] },
  { id: 'openg', name: 'Chitarra · Open G', strings: ['D2', 'G2', 'D3', 'G3', 'B3', 'D4'] },
  { id: 'bass', name: 'Basso 4 corde', strings: ['E1', 'A1', 'D2', 'G2'] },
  { id: 'bass5', name: 'Basso 5 corde', strings: ['B0', 'E1', 'A1', 'D2', 'G2'] },
  { id: 'uke', name: 'Ukulele', strings: ['G4', 'C4', 'E4', 'A4'] },
  { id: 'chrom', name: 'Cromatico (tutte le note)', strings: [] }
]
