import type { MixState, StemId } from './types'

// 'original' = the whole unseparated song, played as a single track
export type TrackId = StemId | 'original'

/* Plays every stem of a song in perfect sync through Web Audio.
   One AudioBufferSourceNode per stem, all started on the same clock tick;
   each goes through its own gain (mute / solo / volume) into a master gain.
   Seeking restarts the sources at the new offset. */
export class Mixer {
  readonly ctx: AudioContext
  private master: GainNode
  private gains = new Map<TrackId, GainNode>()
  private buffers = new Map<TrackId, AudioBuffer>()
  private limiter: DynamicsCompressorNode
  private trim: GainNode
  private level: GainNode // loudness normalisation, before the limiter
  private sources: AudioBufferSourceNode[] = []
  private mix: MixState
  private playing = false
  private startCtx = 0 // ctx time when playback (re)started
  private startOffset = 0 // song position at startCtx
  private pausedAt = 0
  private loop: { a: number; b: number } | null = null
  private endTimer: number | null = null
  onEnded: (() => void) | null = null

  constructor(ctx: AudioContext, mix: MixState) {
    // one AudioContext is shared by every song (Android caps how many can be open)
    this.ctx = ctx
    this.master = this.ctx.createGain()
    // brick-wall-ish limiter: boosting stems above 100% must not clip.
    // Web Audio adds ~+0.57 dB of automatic make-up gain with these
    // settings; the trim takes it back so quiet passages are untouched
    this.limiter = ctx.createDynamicsCompressor()
    this.limiter.threshold.value = -1
    this.limiter.knee.value = 0
    this.limiter.ratio.value = 20
    this.limiter.attack.value = 0.002
    this.limiter.release.value = 0.12
    this.trim = ctx.createGain()
    this.trim.gain.value = Math.pow(10, -0.57 / 20)
    this.level = ctx.createGain()
    this.master.connect(this.level)
    this.level.connect(this.limiter)
    this.limiter.connect(this.trim)
    this.trim.connect(this.ctx.destination)
    this.mix = structuredClone(mix)
    this.master.gain.value = mix.master
  }

  get duration(): number {
    let d = 0
    for (const b of this.buffers.values()) d = Math.max(d, b.duration)
    return d
  }

  get isPlaying(): boolean {
    return this.playing
  }

  addStem(id: TrackId, buffer: AudioBuffer): void {
    this.buffers.set(id, buffer)
    const g = this.ctx.createGain()
    g.gain.value = this.stemGain(id)
    g.connect(this.master)
    this.gains.set(id, g)
  }

  get position(): number {
    if (!this.playing) return this.pausedAt
    let pos = this.startOffset + (this.ctx.currentTime - this.startCtx)
    if (this.loop && pos >= this.loop.b) {
      const len = this.loop.b - this.loop.a
      pos = this.loop.a + ((pos - this.loop.a) % len)
    }
    return Math.min(pos, this.duration)
  }

  async play(): Promise<void> {
    if (this.playing || !this.buffers.size) return
    await this.ctx.resume()
    let from = this.pausedAt
    if (from >= this.duration - 0.05) from = 0
    this.startSources(from)
  }

  pause(): void {
    if (!this.playing) return
    this.pausedAt = this.position
    this.stopSources()
  }

  toggle(): void {
    if (this.playing) this.pause()
    else void this.play()
  }

  seek(t: number): void {
    const to = Math.max(0, Math.min(t, this.duration - 0.01))
    if (this.playing) {
      this.stopSources()
      this.startSources(to)
    } else {
      this.pausedAt = to
    }
  }

  setLoop(loop: { a: number; b: number } | null): void {
    this.loop = loop && loop.b - loop.a > 0.2 ? loop : null
    if (this.playing) {
      const pos = this.position
      this.stopSources()
      this.startSources(this.loop && (pos < this.loop.a || pos > this.loop.b) ? this.loop.a : pos)
    }
  }

  setMix(mix: MixState): void {
    this.mix = structuredClone(mix)
    const now = this.ctx.currentTime
    // short ramps avoid clicks when a stem is muted mid-song
    this.master.gain.setTargetAtTime(mix.master, now, 0.015)
    for (const [id, g] of this.gains) g.gain.setTargetAtTime(this.stemGain(id), now, 0.015)
  }

  private stemGain(id: TrackId): number {
    if (id === 'original') return 1
    const { muted, solo, vols } = this.mix
    if (solo.length) return solo.includes(id) ? (vols[id] ?? 1) : 0
    if (muted.includes(id)) return 0
    return vols[id] ?? 1
  }

  private startSources(from: number): void {
    const when = this.ctx.currentTime + 0.06
    this.sources = []
    for (const [id, buffer] of this.buffers) {
      const src = this.ctx.createBufferSource()
      src.buffer = buffer
      if (this.loop) {
        src.loop = true
        src.loopStart = this.loop.a
        src.loopEnd = this.loop.b
      }
      src.connect(this.gains.get(id)!)
      src.start(when, Math.min(from, buffer.duration))
      this.sources.push(src)
    }
    this.startCtx = when
    this.startOffset = from
    this.playing = true
    this.scheduleEnd()
  }

  private scheduleEnd(): void {
    if (this.endTimer !== null) clearTimeout(this.endTimer)
    this.endTimer = null
    if (this.loop) return
    const remaining = this.duration - this.startOffset + (this.startCtx - this.ctx.currentTime)
    this.endTimer = window.setTimeout(() => {
      if (!this.playing || this.position < this.duration - 0.1) return
      this.stopSources()
      this.pausedAt = 0
      this.onEnded?.()
    }, Math.max(0, remaining * 1000 + 80))
  }

  private stopSources(): void {
    if (this.endTimer !== null) clearTimeout(this.endTimer)
    this.endTimer = null
    for (const s of this.sources) {
      try {
        s.stop()
      } catch {
        /* already stopped */
      }
      s.disconnect()
    }
    this.sources = []
    this.playing = false
  }

  /** loudness normalisation ("volume uniforme"), applied before the limiter */
  setGainDb(db: number): void {
    this.level.gain.value = Math.pow(10, db / 20)
  }

  dispose(): void {
    this.onEnded = null
    this.stopSources()
    for (const g of this.gains.values()) g.disconnect()
    this.master.disconnect()
    this.limiter.disconnect()
    this.trim.disconnect()
    this.level.disconnect()
    this.buffers.clear()
    this.gains.clear()
  }
}
