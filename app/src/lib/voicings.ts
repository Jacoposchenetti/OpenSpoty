/* How to play a chord: every playable guitar shape (standard tuning) worked out
   from the notes — not copied from a chord book — easiest first; and the piano
   keys (root position and inversions). Used by the chord diagrams in Suona. */

/** the notes of each quality (semitones above the root), and which may be left out */
const NOTES: Record<string, { iv: number[]; optional: number[] }> = {
  maj: { iv: [0, 4, 7], optional: [] },
  min: { iv: [0, 3, 7], optional: [] },
  '7': { iv: [0, 4, 7, 10], optional: [7] },
  maj7: { iv: [0, 4, 7, 11], optional: [7] },
  min7: { iv: [0, 3, 7, 10], optional: [7] },
  sus4: { iv: [0, 5, 7], optional: [] },
  sus2: { iv: [0, 2, 7], optional: [] },
  dim: { iv: [0, 3, 6], optional: [] },
  aug: { iv: [0, 4, 8], optional: [] },
  maj6: { iv: [0, 4, 7, 9], optional: [7] },
  min6: { iv: [0, 3, 7, 9], optional: [7] },
  dim7: { iv: [0, 3, 6, 9], optional: [] },
  hdim7: { iv: [0, 3, 6, 10], optional: [] },
  minmaj7: { iv: [0, 3, 7, 11], optional: [7] }
}

export interface Shape {
  /** per string, low E to high E: -1 muted, 0 open, n fret */
  frets: number[]
  /** the finger on each string (0: none) */
  fingers: number[]
  /** one finger across several strings: its fret and the strings it spans */
  barre?: { fret: number; from: number; to: number }
}

const TUNING = [40, 45, 50, 55, 59, 64] // E2 A2 D3 G3 B3 E4

/** the fingers for a shape: a barre with the first if the lowest fret holds several strings, then 2, 3, 4 */
function fingersOf(frets: number[]): { fingers: number[]; barre?: Shape['barre'] } | null {
  const fingers = frets.map(() => 0)
  const pressed = frets.map((f, i) => ({ f, i })).filter((x) => x.f > 0)
  if (!pressed.length) return { fingers }
  const low = Math.min(...pressed.map((x) => x.f))
  const atLow = pressed.filter((x) => x.f === low)
  let barre: Shape['barre']
  let next = 1
  if (atLow.length >= 2) {
    const from = atLow[0].i
    const to = atLow[atLow.length - 1].i
    // a barre holds if nothing between its ends is open or muted (they would sound / be pressed)
    if (frets.slice(from, to + 1).every((f) => f >= low)) {
      barre = { fret: low, from, to }
      for (const x of atLow) fingers[x.i] = 1
      next = 2
    }
  }
  const rest = pressed.filter((x) => fingers[x.i] === 0).sort((a, b) => a.f - b.f || a.i - b.i)
  for (const x of rest) {
    if (next > 4) return null
    fingers[x.i] = next++
  }
  return { fingers, barre }
}

/** every playable shape of the chord, easiest first */
export function guitarShapes(root: number, quality: string, max = 40): Shape[] {
  const def = NOTES[quality] ?? NOTES.maj
  const pcs = def.iv.map((x) => (root + x) % 12)
  const required = def.iv.filter((x) => !def.optional.includes(x)).map((x) => (root + x) % 12)
  const seen = new Set<string>()
  const found: Array<{ shape: Shape; score: number }> = []
  for (let base = 0; base <= 12; base++) {
    const lo = Math.max(1, base)
    const hi = base + 3
    // what each string can do in this window
    const options = TUNING.map((open) => {
      const o = [-1]
      if (pcs.includes(open % 12)) o.push(0)
      for (let f = lo; f <= hi; f++) if (pcs.includes((open + f) % 12)) o.push(f)
      return o
    })
    const frets = [0, 0, 0, 0, 0, 0]
    const walk = (s: number) => {
      if (s === 6) {
        consider([...frets])
        return
      }
      for (const f of options[s]) {
        frets[s] = f
        walk(s + 1)
      }
    }
    const consider = (fr: number[]) => {
      const sounding = fr.map((f, i) => (f < 0 ? -1 : i)).filter((i) => i >= 0)
      if (sounding.length < 4) return
      // muted strings only on the edges (no gap in the middle of the hand)
      const first = sounding[0]
      const last = sounding[sounding.length - 1]
      if (sounding.length !== last - first + 1) return
      if (last < 5 && 5 - last > 1) return // at most the top string left out
      // the root in the bass
      if ((TUNING[first] + fr[first]) % 12 !== root) return
      const have = new Set(sounding.map((i) => (TUNING[i] + fr[i]) % 12))
      if (!required.every((p) => have.has(p))) return
      const pressed = fr.filter((f) => f > 0)
      if (pressed.length && Math.max(...pressed) - Math.min(...pressed) > 3) return
      const key = fr.join(',')
      if (seen.has(key)) return
      const fing = fingersOf(fr)
      if (!fing) return
      seen.add(key)
      const used = new Set(fing.fingers.filter((x) => x > 0)).size
      const opens = fr.filter((f) => f === 0).length
      const mutes = fr.filter((f) => f < 0).length
      const minFret = pressed.length ? Math.min(...pressed) : 0
      const topMuted = fr[5] < 0 ? 1.4 : 0 // a high string left out sounds thin: the full shapes first
      const score = minFret * 1.6 + used * 1.2 + (fing.barre ? 1.5 : 0) + mutes * 0.6 + topMuted - opens * 0.4 + (pressed.length ? Math.max(...pressed) - minFret : 0) * 0.5 - sounding.length * 0.3
      found.push({ shape: { frets: fr, fingers: fing.fingers, barre: fing.barre }, score })
    }
    walk(0)
  }
  return found
    .sort((a, b) => a.score - b.score)
    .slice(0, max)
    .map((x) => x.shape)
}

/** the piano: the chord in root position and its inversions (MIDI notes around middle C) */
export function pianoVoicings(root: number, quality: string): number[][] {
  const iv = (NOTES[quality] ?? NOTES.maj).iv
  const base = 60 + root - (root > 5 ? 12 : 0) // root position near middle C
  const out: number[][] = []
  for (let inv = 0; inv < iv.length; inv++) {
    const notes = iv.map((x, k) => base + x + (k < inv ? 12 : 0)).sort((a, b) => a - b)
    out.push(notes)
  }
  return out
}
