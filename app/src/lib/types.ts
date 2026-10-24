export type StemId = 'vocals' | 'drums' | 'bass' | 'guitar' | 'piano' | 'other'

export const STEM_ORDER: StemId[] = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']

// colors match the StemKit desktop app
export const STEM_META: Record<StemId, { label: string; color: string }> = {
  vocals: { label: 'Voce', color: '#A78BFA' },
  drums: { label: 'Batteria', color: '#F87171' },
  bass: { label: 'Basso', color: '#60A5FA' },
  guitar: { label: 'Chitarra', color: '#F472B6' },
  piano: { label: 'Piano', color: '#FBBF24' },
  other: { label: 'Altro', color: '#34D399' }
}

export function sortStems(stems: string[]): StemId[] {
  return STEM_ORDER.filter((s) => stems.includes(s))
}

export interface MixState {
  muted: StemId[]
  solo: StemId[]
  vols: Partial<Record<StemId, number>>
  master: number
  // practice / transposition, saved per song (native engine only)
  speed?: number // 0.5 .. 1.5
  pitch?: number // semitones, -6 .. +6
}

export const DEFAULT_MIX: MixState = { muted: [], solo: [], vols: {}, master: 1 }

export interface Song {
  id: string
  title: string
  duration: number
  stems: StemId[]
  // where each stem lives: a path under the app's data folder on the
  // phone, or "bridge:<api path>" when testing in a desktop browser
  files: Partial<Record<StemId, string>>
  source: 'pc' | 'device'
  pcId?: string
  addedAt: number
  mix?: MixState
  // the whole song, unseparated, for listening (same path rules as files)
  original?: string
  // play the stems (true) or the original (false); unset = stems when there are any
  useStems?: boolean
  // frames the stems lag behind the original (measured once by the native engine)
  stemOffset?: number
  // integrated loudness (LUFS), measured once on the phone; null = could not measure
  lufs?: number | null
  liked?: boolean
  likedAt?: number
  playedAt?: number
  notes?: string
  cover?: string // local copy of the artwork (path under the data folder)
  art?: string // artwork address (Spotify), until the local copy exists
  artistUri?: string // Spotify artist, for "Vai all'artista"
  /** a podcast episode (lib/podcasts.ts): played from the podcast's server, resumed where you left it */
  episode?: { feed: string; guid: string; podcast: string; date?: number }
  /** all its artists (songs from Spotify), for "Vai agli artisti" */
  artists?: Array<{ name: string; uri?: string }>
  albumUri?: string // Spotify album, for "Vai all'album"
  spotifyUri?: string
  /** chords corrected by hand: start time ("12.34") -> BTC label ("A:min7"), "" = no chord */
  chordEdits?: Record<string, string>
  bpm?: number // detected (or tapped) tempo, for the count-in
}

/** an artist you follow (Spotify uri as id); unfollowing keeps the entry with followed: false, so it syncs */
export interface FollowedArtist {
  id: string
  name: string
  image?: string
  followed: boolean
  followedAt: number
  updatedAt?: number
}

export interface Playlist {
  id: string
  name: string
  songIds: string[]
  createdAt: number
  source?: string // the Spotify album / playlist it was saved from
  pos?: number // place in the library (set by drag and drop, synced)
}

export interface PcSong {
  id: string
  title: string
  duration: number
  addedAt: number
  model?: string
  stems: StemId[]
  source: 'local' | 'youtube'
  ready: boolean
  hasOriginal?: boolean
}

export interface PcJob {
  id: string
  kind: 'upload' | 'youtube'
  title: string
  stage: string
  pct: number
  message: string
  state: 'running' | 'done' | 'failed'
  error: string | null
  songId: string | null
  created: number
}

export interface SearchResult {
  videoId: string
  title: string
  channel?: string
  duration?: number
}
