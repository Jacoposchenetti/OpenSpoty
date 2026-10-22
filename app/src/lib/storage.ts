import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { bridgeBase, type BridgeConfig } from './bridge'
import { isDesktop, isNative } from './native'
import { sortStems, type Playlist, type Song, type StemId } from './types'

/* Phone: JSON files + stem audio in the app's private data folder.
   PC app: the same folder layout kept by the bridge (bridge/pc_app.py), which
   also merges the library with the phone's (see lib/sync.ts).
   Plain browser (development): localStorage, and stems streamed from the PC. */

export interface Deleted {
  songs: Record<string, number>
  playlists: Record<string, number>
}

export interface PcState {
  rev: number
  songs: Song[]
  playlists: Playlist[]
  deleted: Deleted
  files: Record<string, number>
  phoneSync?: { at?: number }
}

/* PC app: every change is merged into the PC's library; the merged result
   comes back so the app sees what the phone changed meanwhile */
const remoteListeners = new Set<(s: PcState) => void>()
export const onRemoteState = (cb: (s: PcState) => void) => (remoteListeners.add(cb), () => void remoteListeners.delete(cb))
export async function postPcState(part: Partial<Pick<PcState, 'songs' | 'playlists' | 'deleted'>>): Promise<PcState> {
  const res = await fetch('/api/sync', { method: 'POST', body: JSON.stringify(part) })
  if (!res.ok) throw new Error(`Errore ${res.status} dal PC`)
  const st = (await res.json()) as PcState
  remoteListeners.forEach((cb) => cb(st))
  return st
}
export async function getPcState(): Promise<PcState> {
  const res = await fetch('/api/sync')
  if (!res.ok) throw new Error(`Errore ${res.status} dal PC`)
  return (await res.json()) as PcState
}

async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    if (isDesktop) {
      const res = await fetch(`/api/lib/file/${name}`)
      return res.ok ? ((await res.json()) as T) : fallback
    }
    if (isNative) {
      const r = await Filesystem.readFile({ path: name, directory: Directory.Data, encoding: Encoding.UTF8 })
      return JSON.parse(r.data as string) as T
    }
    const raw = localStorage.getItem(`stemkit:${name}`)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

async function writeJson(name: string, value: unknown): Promise<void> {
  const data = JSON.stringify(value)
  if (isNative) {
    // write-then-rename so a crash never leaves a half-written library
    await Filesystem.writeFile({ path: `${name}.tmp`, data, directory: Directory.Data, encoding: Encoding.UTF8 })
    await Filesystem.rename({ from: `${name}.tmp`, to: name, directory: Directory.Data, toDirectory: Directory.Data })
    return
  }
  localStorage.setItem(`stemkit:${name}`, data)
}

// PC app: only songs whose audio is already on the PC (the rest is still on its way from the phone)
const complete = (st: PcState) => st.songs.filter((s) => songFiles(s).every((f) => f in st.files))
export const loadLibrary = async () => (isDesktop ? complete(await getPcState()) : readJson<Song[]>('library.json', []))
export const saveLibrary = (songs: Song[]) => (isDesktop ? postPcState({ songs }).then(() => undefined) : writeJson('library.json', songs))
// the old single setlist: migrated once into a "Scaletta" playlist
export const loadSetlist = () => (isDesktop ? Promise.resolve([]) : readJson<string[]>('setlist.json', []))
export const loadPlaylists = async () => (isDesktop ? (await getPcState()).playlists : readJson<Playlist[] | null>('playlists.json', null))
export const savePlaylists = (p: Playlist[]) =>
  isDesktop ? postPcState({ playlists: p }).then(() => undefined) : writeJson('playlists.json', p)
export const loadDeleted = async (): Promise<Deleted> =>
  isDesktop ? (await getPcState()).deleted : readJson<Deleted>('deleted.json', { songs: {}, playlists: {} })
export const saveDeleted = (d: Deleted) => (isDesktop ? postPcState({ deleted: d }).then(() => undefined) : writeJson('deleted.json', d))

/** the audio files a song needs to play (the artwork is optional) */
export function songFiles(s: Song): string[] {
  const out = s.stems.map((id) => s.files[id]).filter((f): f is string => !!f)
  if (s.original) out.push(s.original)
  return out.filter((f) => !f.startsWith('bridge:'))
}
export const loadBridgeConfig = () => readJson<BridgeConfig | null>('bridge.json', null)
export const saveBridgeConfig = (cfg: BridgeConfig) => writeJson('bridge.json', cfg)

let dataUri: string | null = null
async function dataDirUri(): Promise<string> {
  if (!dataUri) dataUri = (await Filesystem.getUri({ path: '', directory: Directory.Data })).uri.replace(/\/+$/, '')
  return dataUri
}

/** Call once at start-up so {@link fileUrl} can answer synchronously. */
export async function initPaths(): Promise<void> {
  if (isNative) await dataDirUri().catch(() => null)
}

/** URL the WebView can load for a file in the app's data folder (null until initPaths). */
export function fileUrl(path: string): string | null {
  if (isDesktop) return `/api/lib/file/${path}`
  return isNative && dataUri ? Capacitor.convertFileSrc(`${dataUri}/${path}`) : null
}

/* Fetch an audio file of a song (a stem or the original) as bytes. */
export async function readAudio(ref: string | undefined, bridge: BridgeConfig | null): Promise<ArrayBuffer> {
  if (!ref) throw new Error('File audio mancante')
  if (ref.startsWith('stream:')) {
    // PC: the bridge fetches it from YouTube (and keeps it in its cache)
    const res = await fetch(`/api/pc/stream/${ref.slice(7)}`)
    if (!res.ok) throw new Error('Non riesco a riprodurre questa canzone da YouTube')
    return res.arrayBuffer()
  }
  if (ref.startsWith('bridge:')) {
    if (!bridge) throw new Error('Collega il PC per ascoltare questa canzone')
    const res = await fetch(bridgeBase(bridge.address) + ref.slice(7), { headers: { 'X-StemKit-Pin': bridge.pin } })
    if (!res.ok) throw new Error(`Errore ${res.status} dal PC`)
    return res.arrayBuffer()
  }
  const url = isDesktop ? `/api/lib/file/${ref}` : Capacitor.convertFileSrc(`${await dataDirUri()}/${ref}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(isDesktop ? 'File audio mancante sul PC' : 'File audio mancante sul telefono')
  return res.arrayBuffer()
}

export const readStem = (song: Song, stem: StemId, bridge: BridgeConfig | null) => readAudio(song.files[stem], bridge)

/** small per-device caches (chords): files on the phone and the PC, localStorage in a plain browser */
export async function readCacheJson<T>(path: string): Promise<T | null> {
  return readJson<T | null>(path, null)
}

export async function writeCacheJson(path: string, value: unknown): Promise<void> {
  try {
    if (isDesktop) {
      await fetch(`/api/lib/file/${path}`, { method: 'POST', body: JSON.stringify(value) })
    } else if (isNative) {
      await Filesystem.writeFile({ path, data: JSON.stringify(value), directory: Directory.Data, encoding: Encoding.UTF8, recursive: true })
    } else localStorage.setItem(`stemkit:${path}`, JSON.stringify(value))
  } catch {
    /* a cache: best effort */
  }
}

/** one file of the data folder (a download being removed) */
export async function deleteFile(path: string): Promise<void> {
  try {
    if (isDesktop) await fetch(`/api/lib/file/${path}`, { method: 'DELETE' })
    else if (isNative) await Filesystem.deleteFile({ path, directory: Directory.Data })
  } catch {
    /* already gone */
  }
}

export async function deleteSongFiles(song: Song): Promise<void> {
  if (!isNative) return
  try {
    await Filesystem.rmdir({ path: `songs/${song.id}`, directory: Directory.Data, recursive: true })
  } catch {
    /* already gone */
  }
}

export interface DeviceMeta {
  songId: string
  title: string
  duration: number
  stems: string[]
  files: Record<string, string>
  original?: string
  finishedAt: number
}

export async function readDeviceMeta(songId: string): Promise<DeviceMeta | null> {
  if (isDesktop) return readJson<DeviceMeta | null>(`songs/${songId}/meta.json`, null)
  if (!isNative) return null
  try {
    const r = await Filesystem.readFile({ path: `songs/${songId}/meta.json`, directory: Directory.Data, encoding: Encoding.UTF8 })
    return JSON.parse(r.data as string) as DeviceMeta
  } catch {
    return null
  }
}

/** Library entry built from (or refreshed with) what the phone wrote in meta.json. */
export function mergeMeta(meta: DeviceMeta, existing?: Song): Song {
  return {
    ...(existing ?? { id: meta.songId, title: meta.title, source: 'device' as const, addedAt: meta.finishedAt }),
    duration: meta.duration || existing?.duration || 0,
    stems: sortStems(meta.stems),
    files: meta.files as Song['files'],
    original: meta.original ?? existing?.original
  }
}

/* Songs written by the Java side (downloads, splits) carry a meta.json:
   new ones are added, songs split later get their stems. Also catches what
   finished while the app was closed. */
export async function collectDeviceSongs(known: Song[]): Promise<{ added: Song[]; updated: Song[] }> {
  const none = { added: [], updated: [] }
  if (!isNative && !isDesktop) return none
  let entries: string[] = []
  try {
    entries = isDesktop
      ? Object.keys((await getPcState()).files)
          .filter((f) => f.endsWith('/meta.json'))
          .map((f) => f.split('/')[1])
      : (await Filesystem.readdir({ path: 'songs', directory: Directory.Data })).files.filter((f) => f.type === 'directory').map((f) => f.name)
  } catch {
    return none
  }
  const byId = new Map(known.map((s) => [s.id, s]))
  const added: Song[] = []
  const updated: Song[] = []
  for (const id of entries) {
    const have = byId.get(id)
    if (have && (have.stems.length > 0 || have.source === 'pc')) continue
    const meta = await readDeviceMeta(id)
    if (!meta) continue // still downloading / splitting, or failed
    if (!have) added.push(mergeMeta(meta))
    else if (meta.stems.length) updated.push(mergeMeta(meta, have))
  }
  return { added, updated }
}
