import { isNative, StemKitNative, type CaptureMatch } from './native'

/* "Cattura": what song is playing around you. The phone listens with its
   microphone and asks Shazam (core/ShazamSignature.java: only an audio
   fingerprint is sent); the PC does the same with the browser's microphone. */

export type CaptureEvent = { phase: 'listening' | 'searching'; seconds: number; level: number }

let stopWeb: (() => void) | null = null

export async function capture(onEvent: (e: CaptureEvent) => void): Promise<CaptureMatch | null> {
  if (isNative) {
    const h = StemKitNative.addListener('capture', onEvent)
    try {
      return (await StemKitNative.capture()).match
    } finally {
      void h.then((x) => x.remove())
    }
  }
  return captureWeb(onEvent)
}

export function stopCapture() {
  if (isNative) void StemKitNative.stopCapture()
  else stopWeb?.()
}

async function captureWeb(onEvent: (e: CaptureEvent) => void): Promise<CaptureMatch | null> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
  const ctx = new AudioContext({ sampleRate: 16000 })
  const src = ctx.createMediaStreamSource(stream)
  const proc = ctx.createScriptProcessor(4096, 1, 1)
  const chunks: Float32Array[] = []
  let total = 0
  let stopped = false
  src.connect(proc)
  proc.connect(ctx.destination)
  const done = () => {
    stopped = true
    proc.disconnect()
    src.disconnect()
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close()
  }
  stopWeb = done
  try {
    for (const at of [5, 10]) {
      await new Promise<void>((resolve) => {
        proc.onaudioprocess = (e) => {
          const d = new Float32Array(e.inputBuffer.getChannelData(0))
          chunks.push(d)
          total += d.length
          let sum = 0
          for (const v of d) sum += v * v
          onEvent({ phase: 'listening', seconds: total / 16000, level: Math.min(1, Math.sqrt(sum / d.length) * 6) })
          if (total >= at * 16000 || stopped) resolve()
        }
      })
      if (stopped && total < at * 16000) return null
      onEvent({ phase: 'searching', seconds: total / 16000, level: 0 })
      const all = new Float32Array(total)
      let o = 0
      for (const c of chunks) {
        all.set(c, o)
        o += c.length
      }
      const res = await fetch('/api/pc/capture', { method: 'POST', body: all.buffer })
      const r = (await res.json()) as { match?: CaptureMatch | null; error?: string }
      if (!res.ok) throw new Error(r.error || `Errore ${res.status}`)
      if (r.match) return r.match
    }
    return null
  } finally {
    done()
    stopWeb = null
  }
}

/* songs captured, newest first */
export interface Captured extends CaptureMatch {
  at: number
}

const KEY = 'stemkit:captures'

export function loadCaptures(): Captured[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Captured[]
  } catch {
    return []
  }
}

export function saveCapture(m: CaptureMatch): Captured[] {
  const list = [{ ...m, at: Date.now() }, ...loadCaptures().filter((x) => !(x.title === m.title && x.artist === m.artist))].slice(0, 50)
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* full */
  }
  return list
}
