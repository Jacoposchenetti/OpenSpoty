import { App as CapApp } from '@capacitor/app'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Bridge, type BridgeConfig } from './lib/bridge'
import { engine } from './lib/engine'
import { errMsg } from './lib/format'
import { isDesktop, isNative, type SeparationEvent } from './lib/native'
import { deleteLyrics } from './lib/lyrics'
import {
  collectDeviceSongs,
  deleteFile,
  deleteSongFiles,
  getPcState,
  loadBridgeConfig,
  loadDeleted,
  loadLibrary,
  loadPlaylists,
  initPaths,
  loadSetlist,
  mergeMeta,
  onRemoteState,
  readDeviceMeta,
  saveBridgeConfig,
  saveDeleted,
  saveLibrary,
  savePlaylists,
  songFiles,
  type Deleted,
  type PcState
} from './lib/storage'
import { isLocalPath, youtubeIdOf } from './lib/media'
import { findPc, mergeDeleted, mergeItems, pingPc, syncWithPc } from './lib/sync'
import type { MixState, Playlist, Song } from './lib/types'

export type Tab = 'library' | 'add' | 'alarm' | 'capture'

/** pages opened on top of a tab (artist, album), like Spotify */
export type Page = { kind: 'artist' | 'album' | 'playlist'; uri: string; name?: string }

export interface SyncStatus {
  state: 'off' | 'syncing' | 'ok' | 'offline' | 'error'
  /** files copied / to copy in the running sync */
  done?: number
  total?: number
  at?: number // last successful sync
  pcName?: string
  error?: string
}
// what the Library tab shows: the overview, all songs, or one playlist
export type LibView = null | 'all' | string

interface Store {
  ready: boolean
  /** the library */
  songs: Song[]
  /** the library plus songs played without being saved (search, artist pages) */
  allSongs: Song[]
  getSong(id: string): Song | undefined
  /** songs heard but not saved (search results, artist pages): kept for this session */
  addTemp(songs: Song[]): void
  /** save a song to the library (streamed: nothing is downloaded) */
  addToLibrary(song: Song, quiet?: boolean): void
  /** keep a song on this device (offline) */
  download(ids: string[]): void
  /** back to streaming: frees the space, keeps the song (split songs keep their stems) */
  removeDownload(ids: string[]): Promise<void>
  /** songs being downloaded now / waiting */
  downloading: string[]
  playlists: Playlist[]
  bridgeCfg: BridgeConfig | null
  bridge: Bridge | null
  tab: Tab
  setTab(t: Tab): void
  pages: Page[]
  openPage(p: Page): void
  closePage(): void
  libView: LibView
  setLibView(v: LibView): void
  playerOpen: boolean
  setPlayerOpen(open: boolean): void
  deviceJob: SeparationEvent | null
  setDeviceJob(e: SeparationEvent | null): void
  removeSong(id: string): Promise<void>
  renameSong(id: string, title: string): Promise<void>
  saveMix(id: string, mix: MixState): void
  /** with a source (a Spotify album), saving it again reuses the same playlist */
  createPlaylist(name: string, songIds?: string[], source?: string): string
  renamePlaylist(id: string, name: string): void
  deletePlaylist(id: string): void
  /** @return how many songs were actually added (duplicates are skipped) */
  addToPlaylist(id: string, songIds: string[]): number
  removeFromPlaylist(id: string, index: number): void
  reorderPlaylist(id: string, from: number, to: number): void
  moveToPlaylist(fromId: string, index: number, toId: string): boolean
  setBridgeCfg(cfg: BridgeConfig): Promise<void>
  /** add (or refresh) a song from what the phone saved */
  adoptSong(songId: string): Promise<Song | null>
  setUseStems(id: string, useStems: boolean): void
  setStemOffset(id: string, frames: number): void
  /** small per-song changes (liked, notes, played, cover, bpm…) */
  updateSong(id: string, patch: Partial<Song>): void
  setLufs(id: string, lufs: number | null): void
  /** "volume uniforme": every song played at the same perceived loudness (always on) */
  normalize: boolean
  /** count-in beats before a song you start (0 = off) */
  countIn: number
  setCountIn(beats: number): void
  /** split a song that was downloaded for listening only (uses the saved original) */
  splitLater(song: Song): Promise<void>
  /** phone ⇄ PC library sync */
  sync: SyncStatus
  syncNow(): void
  toast: string | null
  showToast(msg: string): void
}

const Ctx = createContext<Store | null>(null)

export function useStore(): Store {
  const s = useContext(Ctx)
  if (!s) throw new Error('store missing')
  return s
}

/* every changed song / playlist gets a fresh updatedAt: the newer copy wins when syncing */
function stamp<T extends { id: string; updatedAt?: number }>(prev: T[], next: T[]): T[] {
  const old = new Map(prev.map((x) => [x.id, x]))
  const now = Date.now()
  return next.map((x) => (old.get(x.id) === x ? x : { ...x, updatedAt: now }))
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const newId = () => `pl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

export function StoreProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [songs, setSongs] = useState<Song[]>([])
  const [playlists, setPlaylistsState] = useState<Playlist[]>([])
  const [bridgeCfg, setBridgeState] = useState<BridgeConfig | null>(null)
  const [tab, setTabState] = useState<Tab>('library')
  const [pages, setPages] = useState<Page[]>([])
  const setTab = useCallback((t: Tab) => {
    setTabState(t)
    setPages([])
  }, [])
  const [libView, setLibView] = useState<LibView>(null)
  const [playerOpen, setPlayerOpen] = useState(false)
  const [deviceJob, setDeviceJob] = useState<SeparationEvent | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [sync, setSync] = useState<SyncStatus>({ state: 'off' })
  const [countIn, setCountInState] = useState<number>(() => {
    try {
      return Number(localStorage.getItem('stemkit:countIn') ?? '0') || 0
    } catch {
      return 0
    }
  })
  const songsRef = useRef<Song[]>([])
  const playlistsRef = useRef<Playlist[]>([])
  const deletedRef = useRef<Deleted>({ songs: {}, playlists: {} })
  const toastTimer = useRef<number | null>(null)
  const changed = useRef(0) // bumped by local edits: schedules a sync
  const tempRef = useRef(new Map<string, Song>())
  const [temp, setTemp] = useState<Song[]>([])
  const [downloading, setDownloading] = useState<string[]>([])
  const dlQueue = useRef<string[]>([])

  const commitSongs = useCallback(async (next: Song[], remote = false) => {
    if (!remote) {
      next = stamp(songsRef.current, next)
      changed.current++
    }
    songsRef.current = next
    setSongs(next)
    if (!remote || !isDesktop) await saveLibrary(next)
  }, [])

  const commitPlaylists = useCallback((next: Playlist[], remote = false) => {
    if (!remote) {
      next = stamp(playlistsRef.current, next)
      changed.current++
    }
    playlistsRef.current = next
    setPlaylistsState(next)
    if (!remote || !isDesktop) void savePlaylists(next)
  }, [])

  const tombstone = useCallback((kind: keyof Deleted, id: string) => {
    deletedRef.current = { ...deletedRef.current, [kind]: { ...deletedRef.current[kind], [id]: Date.now() } }
    void saveDeleted(deletedRef.current)
  }, [])

  /* what the PC sent back (the merged library): keeps whatever changed here meanwhile */
  const applyRemote = useCallback(
    async (st: PcState, ready: (s: Song) => boolean) => {
      const deleted = mergeDeleted(deletedRef.current, st.deleted)
      const songs = mergeItems(songsRef.current, st.songs.filter(ready), deleted.songs)
      const playlists = mergeItems(playlistsRef.current, st.playlists, deleted.playlists)
      // a song (or playlist) that came back is no longer deleted
      for (const x of songs) delete deleted.songs[x.id]
      for (const x of playlists) delete deleted.playlists[x.id]
      // songs deleted on the other device: their files go too
      const gone = songsRef.current.filter((s) => !songs.some((x) => x.id === s.id))
      for (const s of gone) {
        await deleteSongFiles(s)
        void deleteLyrics(s.id)
      }
      if (!sameJson(deleted, deletedRef.current)) {
        deletedRef.current = deleted
        if (!isDesktop) void saveDeleted(deleted)
      }
      if (!sameJson(songs, songsRef.current)) await commitSongs(songs, true)
      if (!sameJson(playlists, playlistsRef.current)) commitPlaylists(playlists, true)
    },
    [commitSongs, commitPlaylists]
  )

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3000)
  }, [])

  // pick up songs the phone finished splitting while we were closed
  const adoptDeviceSongs = useCallback(async () => {
    const { added, updated } = await collectDeviceSongs(songsRef.current)
    if (added.length || updated.length) {
      const upd = new Map(updated.map((s) => [s.id, s]))
      await commitSongs([...added, ...songsRef.current.map((s) => upd.get(s.id) ?? s)])
    }
    return [...added, ...updated]
  }, [commitSongs])

  const adoptSong = useCallback(
    async (songId: string) => {
      const meta = await readDeviceMeta(songId)
      if (!meta) return null
      const existing = songsRef.current.find((s) => s.id === songId)
      const song = mergeMeta(meta, existing)
      await commitSongs(existing ? songsRef.current.map((s) => (s.id === songId ? song : s)) : [song, ...songsRef.current])
      return song
    },
    [commitSongs]
  )

  useEffect(() => {
    void (async () => {
      const [lib, saved, oldSetlist, cfg, deleted] = await Promise.all([
        loadLibrary(),
        loadPlaylists(),
        loadSetlist(),
        isDesktop ? null : loadBridgeConfig(),
        loadDeleted(),
        initPaths()
      ])
      deletedRef.current = deleted
      songsRef.current = lib
      setSongs(lib)
      const known = new Set(lib.map((s) => s.id))
      let pls = saved ?? []
      if (!saved) {
        // first run with playlists: the old setlist becomes "Scaletta"
        const ids = oldSetlist.filter((id) => known.has(id))
        pls = ids.length ? [{ id: newId(), name: 'Scaletta', songIds: ids, createdAt: Date.now() }] : []
        void savePlaylists(pls)
      }
      playlistsRef.current = pls
      setPlaylistsState(pls)
      setBridgeState(cfg)
      await adoptDeviceSongs()
      if (engine.available) {
        const st = await engine.separationStatus().catch(() => null)
        if (st && st.state === 'running') setDeviceJob(st)
      }
      setReady(true)
    })()
  }, [adoptDeviceSongs])

  useEffect(
    () =>
      engine.onSeparation((e) => {
        setDeviceJob(e)
        if (e.state === 'done') {
          void adoptSong(e.songId).then((song) => {
            if (song) showToast(`“${song.title}”: tracce pronte`)
          })
        }
      }),
    [adoptSong, showToast]
  )

  const bridge = useMemo(() => (bridgeCfg ? new Bridge(bridgeCfg) : null), [bridgeCfg])

  /* PC app: the phone (or a split) changed the PC's library: show it */
  useEffect(() => {
    if (!isDesktop || !ready) return
    let rev = 0
    const show = (st: PcState) => {
      rev = Math.max(rev, st.rev)
      if (st.phoneSync?.at) setSync({ state: 'ok', at: st.phoneSync.at })
      return applyRemote(st, (s) => songFiles(s).every((f) => f in st.files))
    }
    const off = onRemoteState((st) => void show(st))
    const t = setInterval(async () => {
      try {
        const r = (await (await fetch('/api/sync/rev')).json()) as { rev: number }
        if (r.rev !== rev) await show(await getPcState())
      } catch {
        /* bridge restarting */
      }
    }, 2500)
    return () => {
      off()
      clearInterval(t)
    }
  }, [ready, applyRemote])

  /* phone: sync with the PC at start, on resume, after edits and every minute */
  const syncing = useRef(false)
  const cfgRef = useRef(bridgeCfg)
  cfgRef.current = bridgeCfg
  const lastSearch = useRef(0)
  const runSync = useCallback(
    async (manual = false) => {
      let cfg = cfgRef.current
      if (!isNative || !cfg || syncing.current) return
      syncing.current = true
      const startedAt = changed.current
      try {
        try {
          await pingPc(cfg)
        } catch (e) {
          // the PC may have a new address: look for it (not too often)
          if (/PIN/.test(errMsg(e)) || (!manual && Date.now() - lastSearch.current < 10 * 60_000)) throw e
          lastSearch.current = Date.now()
          const found = await findPc(cfg)
          if (!found) throw e
          cfg = found
          cfgRef.current = found
          setBridgeState(found)
          await saveBridgeConfig(found)
        }
        setSync((s) => ({ ...s, state: 'syncing', done: 0, total: 0 }))
        const r = await syncWithPc(
          cfg,
          { songs: songsRef.current, playlists: playlistsRef.current, deleted: deletedRef.current },
          (p) => setSync((s) => ({ ...s, state: 'syncing', done: p.done, total: p.total }))
        )
        await applyRemote(r.state, (s) => r.ready.has(s.id))
        setSync({ state: 'ok', at: Date.now(), pcName: r.name })
        // edits made while syncing go out right away
        if (changed.current !== startedAt) window.setTimeout(() => void runSync(), 1000)
      } catch (e) {
        const msg = errMsg(e)
        setSync((s) => ({ ...s, state: /PIN/.test(msg) ? 'error' : 'offline', error: msg }))
      } finally {
        syncing.current = false
      }
    },
    [applyRemote]
  )

  useEffect(() => {
    if (!isNative || !ready || !bridgeCfg) return
    void runSync()
    const t = setInterval(() => void runSync(), 60_000)
    const h = CapApp.addListener('resume', () => void runSync())
    return () => {
      clearInterval(t)
      void h.then((x) => x.remove())
    }
  }, [ready, bridgeCfg, runSync])

  // local edits: sync a few seconds later
  useEffect(() => {
    if (!isNative) return
    let seen = changed.current
    const t = setInterval(() => {
      if (changed.current !== seen) {
        seen = changed.current
        void runSync()
      }
    }, 4000)
    return () => clearInterval(t)
  }, [runSync])

  const removeSong = useCallback(
    async (id: string) => {
      const song = songsRef.current.find((s) => s.id === id)
      if (song) await deleteSongFiles(song)
      void deleteLyrics(id)
      tombstone('songs', id)
      await commitSongs(songsRef.current.filter((s) => s.id !== id))
      commitPlaylists(playlistsRef.current.map((p) => ({ ...p, songIds: p.songIds.filter((x) => x !== id) })))
    },
    [commitSongs, commitPlaylists, tombstone]
  )

  const renameSong = useCallback(
    async (id: string, title: string) => {
      await commitSongs(songsRef.current.map((s) => (s.id === id ? { ...s, title } : s)))
    },
    [commitSongs]
  )

  // mixer changes are frequent (sliders): persist at most every 600 ms
  const mixTimer = useRef<number | null>(null)
  const saveMix = useCallback((id: string, mix: MixState) => {
    const next = songsRef.current.map((s) => (s.id === id ? { ...s, mix, updatedAt: Date.now() } : s))
    changed.current++
    songsRef.current = next
    setSongs(next)
    if (mixTimer.current) clearTimeout(mixTimer.current)
    mixTimer.current = window.setTimeout(() => void saveLibrary(songsRef.current), 600)
  }, [])

  // ------------------------------------------------------------ playlists
  const updatePlaylist = useCallback(
    (id: string, fn: (p: Playlist) => Playlist) => {
      commitPlaylists(playlistsRef.current.map((p) => (p.id === id ? fn(p) : p)))
    },
    [commitPlaylists]
  )

  const createPlaylist = useCallback(
    (name: string, songIds: string[] = [], source?: string) => {
      const same = source && playlistsRef.current.find((x) => x.source === source)
      if (same) return same.id
      const p: Playlist = { id: newId(), name: name.trim() || 'Nuova playlist', songIds: [...new Set(songIds)], createdAt: Date.now() }
      if (source) p.source = source
      commitPlaylists([...playlistsRef.current, p])
      return p.id
    },
    [commitPlaylists]
  )

  const addToPlaylist = useCallback(
    (id: string, songIds: string[]) => {
      const p = playlistsRef.current.find((x) => x.id === id)
      if (!p) return 0
      const fresh = songIds.filter((s, i) => !p.songIds.includes(s) && songIds.indexOf(s) === i)
      if (fresh.length) updatePlaylist(id, (x) => ({ ...x, songIds: [...x.songIds, ...fresh] }))
      return fresh.length
    },
    [updatePlaylist]
  )

  const removeFromPlaylist = useCallback(
    (id: string, index: number) => updatePlaylist(id, (p) => ({ ...p, songIds: p.songIds.filter((_, i) => i !== index) })),
    [updatePlaylist]
  )

  const reorderPlaylist = useCallback(
    (id: string, from: number, to: number) =>
      updatePlaylist(id, (p) => {
        const ids = [...p.songIds]
        const [moved] = ids.splice(from, 1)
        ids.splice(to, 0, moved)
        return { ...p, songIds: ids }
      }),
    [updatePlaylist]
  )

  const moveToPlaylist = useCallback(
    (fromId: string, index: number, toId: string) => {
      const from = playlistsRef.current.find((p) => p.id === fromId)
      const songId = from?.songIds[index]
      if (!songId || fromId === toId) return false
      commitPlaylists(
        playlistsRef.current.map((p) => {
          if (p.id === fromId) return { ...p, songIds: p.songIds.filter((_, i) => i !== index) }
          if (p.id === toId && !p.songIds.includes(songId)) return { ...p, songIds: [...p.songIds, songId] }
          return p
        })
      )
      return true
    },
    [commitPlaylists]
  )

  const setBridgeCfg = useCallback(async (cfg: BridgeConfig) => {
    setBridgeState(cfg)
    await saveBridgeConfig(cfg)
  }, [])

  const getSong = useCallback((id: string) => songsRef.current.find((s) => s.id === id) ?? tempRef.current.get(id), [])
  const addTemp = useCallback((list: Song[]) => {
    let added = false
    for (const x of list) {
      if (!songsRef.current.some((s) => s.id === x.id) && !tempRef.current.has(x.id)) {
        tempRef.current.set(x.id, x)
        added = true
      }
    }
    if (added) setTemp([...tempRef.current.values()])
  }, [])
  const allSongs = useMemo(() => (temp.length ? [...songs, ...temp.filter((t) => !songs.some((s) => s.id === t.id))] : songs), [songs, temp])

  /* downloads, one at a time: on the phone they go to the song's folder (from
     the stream cache if it was played to the end) */
  const downloadNext = useCallback(async () => {
    while (dlQueue.current.length) {
      const id = dlQueue.current[0]
      const song = getSong(id)
      const vid = youtubeIdOf(id)
      if (song && vid && !isLocalPath(song.original)) {
        try {
          if (!songsRef.current.some((s) => s.id === id)) await commitSongs([{ ...song, addedAt: Date.now() }, ...songsRef.current])
          await engine.downloadYoutube({ videoId: vid, songId: id, title: song.title })
          await adoptSong(id)
        } catch (e) {
          showToast(`“${song.title}”: ${errMsg(e)}`)
        }
      }
      dlQueue.current.shift()
      setDownloading([...dlQueue.current])
    }
  }, [getSong, commitSongs, adoptSong, showToast])

  const download = useCallback(
    (ids: string[]) => {
      if (!engine.available) return
      const idle = dlQueue.current.length === 0
      for (const id of ids) if (!dlQueue.current.includes(id)) dlQueue.current.push(id)
      setDownloading([...dlQueue.current])
      if (idle) void downloadNext()
    },
    [downloadNext]
  )

  const removeDownload = useCallback(
    async (ids: string[]) => {
      dlQueue.current = dlQueue.current.filter((x) => !ids.includes(x))
      setDownloading([...dlQueue.current])
      const next = []
      for (const s of songsRef.current) {
        if (ids.includes(s.id) && !s.stems.length && isLocalPath(s.original) && youtubeIdOf(s.id)) {
          await deleteFile(s.original)
          await deleteFile(`songs/${s.id}/meta.json`)
          const { original: _, ...rest } = s
          next.push(rest)
        } else next.push(s)
      }
      await commitSongs(next)
    },
    [commitSongs]
  )

  const value: Store = {
    ready,
    songs,
    playlists,
    bridgeCfg,
    bridge,
    tab,
    setTab,
    pages,
    openPage: (p) => {
      setPlayerOpen(false)
      setPages((all) => [...all, p])
    },
    closePage: () => setPages((all) => all.slice(0, -1)),
    libView,
    setLibView,
    playerOpen,
    setPlayerOpen,
    deviceJob,
    setDeviceJob,
    removeSong,
    renameSong,
    saveMix,
    createPlaylist,
    renamePlaylist: (id, name) => updatePlaylist(id, (p) => ({ ...p, name: name.trim() || p.name })),
    deletePlaylist: (id) => {
      tombstone('playlists', id)
      commitPlaylists(playlistsRef.current.filter((p) => p.id !== id))
    },
    addToPlaylist,
    removeFromPlaylist,
    reorderPlaylist,
    moveToPlaylist,
    setBridgeCfg,
    adoptSong,
    setUseStems: (id, useStems) => void commitSongs(songsRef.current.map((s) => (s.id === id ? { ...s, useStems } : s))),
    setLufs: (id, lufs) => void commitSongs(songsRef.current.map((s) => (s.id === id ? { ...s, lufs } : s))),
    countIn,
    setCountIn: (beats) => {
      setCountInState(beats)
      try {
        localStorage.setItem('stemkit:countIn', String(beats))
      } catch {
        /* ignore */
      }
    },
    normalize: true,
    updateSong: (id, patch) => {
      const t = !songsRef.current.some((s) => s.id === id) && tempRef.current.get(id)
      if (!t) return void commitSongs(songsRef.current.map((s) => (s.id === id ? { ...s, ...patch } : s)))
      // liking a song that isn't saved (or writing a note on it) saves it; just hearing it doesn't
      if (patch.liked || patch.notes || patch.chordEdits) void commitSongs([{ ...t, ...patch, addedAt: Date.now() }, ...songsRef.current])
      else tempRef.current.set(id, { ...t, ...patch })
    },
    allSongs,
    getSong,
    addTemp,
    addToLibrary: (song, quiet) => {
      if (songsRef.current.some((s) => s.id === song.id)) return
      void commitSongs([{ ...song, addedAt: Date.now() }, ...songsRef.current])
      if (!quiet) showToast(`“${song.title}” aggiunta alla libreria`)
    },
    download,
    removeDownload,
    downloading,
    setStemOffset: (id, frames) => {
      if (songsRef.current.find((s) => s.id === id)?.stemOffset === frames) return
      void commitSongs(songsRef.current.map((s) => (s.id === id ? { ...s, stemOffset: frames } : s)))
    },
    splitLater: async (song) => {
      const vid = youtubeIdOf(song.id)
      const local = isLocalPath(song.original)
      if (!engine.available || (!local && !vid)) {
        showToast('Questa canzone non si può separare qui')
        return
      }
      try {
        // separating is wanting it on this device: a streamed song is downloaded first
        if (!songsRef.current.some((s) => s.id === song.id)) await commitSongs([{ ...song, addedAt: Date.now() }, ...songsRef.current])
        await engine.separate(local ? { existing: true, songId: song.id, title: song.title } : { youtubeId: vid!, songId: song.id, title: song.title })
        showToast(deviceJob?.state === 'running' ? `In coda: “${song.title}”` : `Separo “${song.title}”…`)
      } catch (e) {
        showToast(errMsg(e))
      }
    },
    sync,
    syncNow: () => void runSync(true),
    toast,
    showToast
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
