import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export const isNative = Capacitor.isNativePlatform()
/** the same app opened on the PC, served by the bridge (bridge/pc_app.py) */
export const isDesktop = !isNative && (window as { __STEMKIT_DESKTOP__?: number }).__STEMKIT_DESKTOP__ === 1

export interface PickedAudio {
  uri: string
  name: string
  size: number
}

export interface SeparationEvent {
  songId: string
  state: 'running' | 'done' | 'failed'
  pct: number
  message: string
  title?: string
  stems?: string[]
  duration?: number
  error?: string
  queue?: string[]
}

export type Quality = 'flac' | 'aac'

export interface YtResult {
  videoId: string
  title: string
  channel: string
  duration?: number
  thumbnail?: string
  kind: 'song' | 'video'
}

export interface CaptureMatch {
  title: string
  artist: string
  image?: string
  album?: string
  year?: string
  genre?: string
  url?: string
}

export interface TransferEvent {
  id: string
  pct: number
}

/* Java side: android/app/src/main/java/app/stemkitmobile/StemKitNativePlugin.java */
export interface StemKitNativePlugin {
  setLanguage(opts: { language: 'it' | 'en' }): Promise<void>
  setBridgeTrust(opts: { fingerprint: string }): Promise<void>
  pickAudio(): Promise<PickedAudio>
  upload(opts: { id: string; uri: string; url: string; pin: string; fingerprint?: string; filename: string }): Promise<{ status: number; body: string }>
  download(opts: { id: string; url: string; pin: string; fingerprint?: string; path: string }): Promise<{ path: string; size: number }>
  podcastSearch(opts: { query: string }): Promise<{ results: import('./podcasts').Podcast[] }>
  podcastFeed(opts: { url: string }): Promise<import('./podcasts').PodcastFeed>
  /** looks up the YouTube streams of songs likely to be played next (faster start) */
  warmStreams(opts: { videoIds: string[]; prefetch?: number }): Promise<void>
  /** downloads a release APK and opens Android's installer */
  installUpdate(opts: { url: string }): Promise<{ needsPermission: boolean }>
  /** every file under songs/ with its size */
  listFiles(): Promise<{ files: Record<string, number> }>
  /** sends a file of the data folder to the PC, keeping it */
  pushFile(opts: { id: string; path: string; url: string; pin: string; fingerprint?: string }): Promise<void>
  separate(opts: {
    uri?: string
    youtubeId?: string
    existing?: boolean
    quality?: Quality
    songId: string
    title: string
    stems: string[]
  }): Promise<void>
  downloadYoutube(opts: { videoId: string; songId: string; title: string }): Promise<{ original: string; duration: number }>
  importAudio(opts: { uri: string; songId: string; title: string }): Promise<{ original: string; duration: number }>
  cancelSeparation(opts?: { all?: boolean }): Promise<void>
  storageUsage(): Promise<{ songs: Array<{ id: string; total: number; stems: number; original: number }>; free: number }>
  deleteStems(opts: { songId: string }): Promise<void>
  ytSearch(opts: { query: string }): Promise<{ results: YtResult[] }>
  spotifyQuery(opts: { url: string }): Promise<{ query: string }>
  suggest(opts: { query: string }): Promise<{ suggestions: string[] }>
  spSearch(opts: { query: string }): Promise<import('./engine').SpSearch>
  spArtist(opts: { uri: string }): Promise<import('./engine').SpArtist>
  spAlbum(opts: { uri: string }): Promise<import('./engine').SpAlbum>
  spotifyList(opts: { url: string }): Promise<import('./engine').SpotifyList>
  matchSong(opts: { title: string; artist: string; duration: number }): Promise<{ videoId: string; title: string; channel: string; duration: number; score: number }>
  separationStatus(): Promise<SeparationEvent | { state: 'idle' }>
  addListener(event: 'separation', cb: (e: SeparationEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'transfer', cb: (e: TransferEvent) => void): Promise<PluginListenerHandle>
  /** "Cattura": listens and asks Shazam (core/ShazamSignature.java) */
  capture(): Promise<{ match: CaptureMatch | null; stopped?: boolean }>
  stopCapture(): Promise<void>
  addListener(event: 'capture', cb: (e: { phase: 'listening' | 'searching'; seconds: number; level: number }) => void): Promise<PluginListenerHandle>
}

export const StemKitNative = registerPlugin<StemKitNativePlugin>('StemKitNative')
