import { engine } from './engine'
import { readCacheJson, writeCacheJson } from './storage'

/* The words of a podcast episode, in time: Whisper (core/Whisper.java) writes
   them 30 s at a time a few minutes ahead of what you hear; they are saved, so
   an episode is transcribed once. Other languages: Google Translate, also saved. */

export interface Seg {
  a: number // s
  b: number
  text: string
}

export interface Transcript {
  lang: string // what is spoken ('' until Whisper heard it)
  segs: Seg[]
  /** the stretches already transcribed: [from, to] seconds */
  done: Array<[number, number]>
  /** where the audio ends (once reached) */
  end?: number
  /** translations: language -> segment start (2 decimals) -> text */
  tr: Record<string, Record<string, string>>
}

const file = (id: string) => `transcripts/${id}.json`

export async function loadTranscript(id: string): Promise<Transcript> {
  return (await readCacheJson<Transcript>(file(id))) ?? { lang: '', segs: [], done: [], tr: {} }
}

export const saveTranscript = (id: string, t: Transcript) => writeCacheJson(file(id), t)

/** the first second not transcribed yet between from and to (null: all done) */
export function firstGap(t: Transcript, from: number, to: number): number | null {
  let at = Math.max(0, from)
  if (t.end !== undefined && at >= t.end - 1) return null
  for (const [a, b] of [...t.done].sort((x, y) => x[0] - y[0])) {
    if (a > at + 0.5) break
    if (b > at) at = b
  }
  if (t.end !== undefined && at >= t.end - 1) return null
  return at < to ? at : null
}

/** transcribes the 30 s from `from` and puts them in (replacing what was there) */
export async function transcribeAt(id: string, src: string, t: Transcript, from: number, onProgress?: (pct: number, downloading: boolean) => void): Promise<Transcript> {
  const r = await engine.transcribe(id, src, from, t.lang, onProgress)
  const to = Math.max(r.next, from + 1)
  const segs = [...t.segs.filter((s) => s.a < from - 0.2 || s.a >= to), ...r.segments].sort((x, y) => x.a - y.a)
  const done = mergeRanges([...t.done, [from, to]])
  const next: Transcript = { ...t, lang: t.lang || r.lang, segs, done, end: r.ended ? to : t.end }
  await saveTranscript(id, next)
  return next
}

function mergeRanges(r: Array<[number, number]>): Array<[number, number]> {
  const s = [...r].sort((x, y) => x[0] - y[0])
  const out: Array<[number, number]> = []
  for (const x of s) {
    const last = out[out.length - 1]
    if (last && x[0] <= last[1] + 0.5) last[1] = Math.max(last[1], x[1])
    else out.push([x[0], x[1]])
  }
  return out
}

const key = (s: Seg) => s.a.toFixed(2)

/** the segments still without a translation in `to` get one */
export async function translateMissing(id: string, t: Transcript, to: string): Promise<Transcript> {
  const have = t.tr[to] ?? {}
  const missing = t.segs.filter((s) => !(key(s) in have))
  if (!missing.length) return t
  const texts = await engine.translate(
    missing.map((s) => s.text),
    to
  )
  const tr = { ...have }
  missing.forEach((s, i) => (tr[key(s)] = texts[i] ?? s.text))
  const next = { ...t, tr: { ...t.tr, [to]: tr } }
  await saveTranscript(id, next)
  return next
}

export const translated = (t: Transcript, lang: string, s: Seg) => (lang && lang !== t.lang ? t.tr[lang]?.[key(s)] : undefined) ?? s.text

export const LANGS: Array<[string, string]> = [
  ['it', 'Italiano'],
  ['en', 'English'],
  ['es', 'Español'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['pt', 'Português']
]
