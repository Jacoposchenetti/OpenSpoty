import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import type { MixState } from './types'

/* Native playback engine (android/.../audio/Engine.java via StemPlayerPlugin.java). */

export interface PlayerSpec {
  songId: string
  title: string
  original?: string // path under the app's data folder
  stems: Record<string, string>
  mix: MixState
  offset?: number | null
  duration: number
  startAt?: number
  autoplay?: boolean
  gainDb?: number
  bpm?: number
  countIn?: boolean
}

export interface PlayerEvent {
  type: 'state' | 'tick' | 'ended' | 'offset' | 'remote' | 'advanced'
  dir?: 'next' | 'prev'
  title?: string
  songId?: string | null
  playing?: boolean
  loading?: boolean
  pos?: number
  dur?: number
  source?: 'original' | 'stems' | 'none'
  willUse?: 'original' | 'stems' | 'none'
  loop?: boolean
  countIn?: boolean
  sleepAt?: number
  sleepAtEnd?: boolean
  error?: string
  offset?: number
  confidence?: number
  action?: 'next' | 'prev'
}

export interface StemPlayerPlugin {
  load(spec: PlayerSpec): Promise<void>
  preload(spec: PlayerSpec): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  seek(opts: { t: number }): Promise<void>
  setMix(opts: { mix: MixState }): Promise<void>
  setLoop(opts: { a: number; b: number }): Promise<void>
  stop(): Promise<void>
  /** the engine plays these next on its own (end of song, notification buttons), also in background */
  setUpcoming(opts: { next: PlayerSpec[]; previous: PlayerSpec | null; autoAdvance: boolean; repeatOne?: boolean }): Promise<void>
  next(): Promise<void>
  prev(): Promise<void>
  setGain(opts: { db: number }): Promise<void>
  setCountIn(opts: { beats: number }): Promise<void>
  setBpm(opts: { songId: string; bpm: number }): Promise<void>
  setSleep(opts: { minutes: number }): Promise<void>
  detectBpm(opts: { path: string }): Promise<{ bpm: number | null }>
  measureLoudness(opts: { paths: string[] }): Promise<{ lufs: number | null }>
  chords(opts: { songId: string; paths: string[] }): Promise<import('./chords').ChordData>
  addListener(event: 'chords', cb: (e: { songId: string; pct: number }) => void): Promise<PluginListenerHandle>
  state(): Promise<PlayerEvent>
  addListener(event: 'player', cb: (e: PlayerEvent) => void): Promise<PluginListenerHandle>
}

export const StemPlayer = registerPlugin<StemPlayerPlugin>('StemPlayer')
