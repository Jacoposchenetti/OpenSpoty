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
  /** for the system's media controls (lock screen, quick settings) */
  name?: string
  artist?: string
  cover?: string // local artwork, path under the app's data folder
  art?: string // artwork address, when there is no local copy
}

export interface PlayerEvent {
  type: 'state' | 'tick' | 'ended' | 'offset' | 'remote' | 'advanced' | 'jam' | 'jamFound' | 'jamLost'
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
  /** 'advanced' to a song of the Jam's queue (maybe one a friend added: what it takes to show it) */
  fromJam?: boolean
  duration?: number
  art?: string
  /** 'jamFound' / 'jamLost': a Jam on this network */
  name?: string
  url?: string
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
  /** fade: seconds of fade-out before the stop; finishSong: when the time is up, stop at the end of the song */
  setSleep(opts: { minutes: number; fade?: number; finishSong?: boolean }): Promise<void>
  /** Jam (Jam.java): this phone hosts a shared queue friends add to */
  jamStart(opts: { host: string; allowControl: boolean }): Promise<import('./jam').JamState>
  jamStop(): Promise<void>
  jamState(): Promise<import('./jam').JamState>
  jamAdd(opts: { spec: PlayerSpec; by: string }): Promise<void>
  jamEdit(opts: { key: string; action: 'remove' | 'up' | 'down' }): Promise<{ ok: boolean }>
  jamSetControl(opts: { allowControl: boolean }): Promise<void>
  /** Jams of other phones on this Wi-Fi: 'jamFound' / 'jamLost' events */
  jamDiscover(opts: { on: boolean }): Promise<void>
  /** a request to another phone's Jam */
  jamRequest(opts: { base: string; path: string; method?: 'GET' | 'POST'; body?: string }): Promise<{ text: string }>
  detectBpm(opts: { path: string }): Promise<{ bpm: number | null }>
  measureLoudness(opts: { paths: string[] }): Promise<{ lufs: number | null }>
  chords(opts: { songId: string; paths: string[] }): Promise<import('./chords').ChordData>
  alignLyrics(opts: { songId: string; path: string; lines: string[] }): Promise<{ times: number[] }>
  transcribe(opts: { songId: string; path: string; from: number; lang: string }): Promise<{
    lang: string
    segments: Array<{ a: number; b: number; text: string }>
    next: number
    ended: boolean
  }>
  translate(opts: { texts: string[]; to: string }): Promise<{ texts: string[] }>
  rhythm(opts: { songId: string; paths: string[] }): Promise<import('./rhythm').RhythmData>
  addListener(event: 'rhythm', cb: (e: { songId: string; pct: number }) => void): Promise<PluginListenerHandle>
  addListener(event: 'align', cb: (e: { songId: string; pct: number; downloading: boolean }) => void): Promise<PluginListenerHandle>
  addListener(event: 'chords', cb: (e: { songId: string; pct: number }) => void): Promise<PluginListenerHandle>
  state(): Promise<PlayerEvent>
  addListener(event: 'player', cb: (e: PlayerEvent) => void): Promise<PluginListenerHandle>
}

export const StemPlayer = registerPlugin<StemPlayerPlugin>('StemPlayer')
