import { KeepAwake } from '@capacitor-community/keep-awake'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { engine, type SpotifyList } from './lib/engine'
import { errMsg } from './lib/format'
import { isNative } from './lib/native'
import { useStore } from './store'
import { t } from './lib/i18n'

/* Playlists being imported (Spotify, SoundCloud, Spotify's data export): they
   keep going while you use the rest of the app, one after the other. The
   "liked songs" of an export become your Brani che ti piacciono, not a playlist. */

export type TrackState = 'attesa' | 'cerco' | 'scarico' | 'fatto' | 'già presente' | 'non trovata'

export interface Import {
  id: string
  url: string
  list: SpotifyList | null
  error: string | null
  states: TrackState[]
  phase: 'loading' | 'ready' | 'running' | 'done'
  /** the songs go to "Brani che ti piacciono" instead of a new playlist */
  liked?: boolean
}

type Opts = { download: boolean; split: boolean }

interface Imports {
  items: Import[]
  /** a playlist from its link; auto: imported as soon as it is read (streaming only) */
  add(url: string, auto?: boolean): void
  /** a list already read (a profile's likes, Spotify's export) */
  addList(list: SpotifyList, o?: { liked?: boolean; auto?: boolean }): void
  start(id: string, opts: Opts): void
  stop(id: string): void
  remove(id: string): void
}

const Ctx = createContext<Imports | null>(null)

export function useImports(): Imports {
  const c = useContext(Ctx)
  if (!c) throw new Error('imports missing')
  return c
}

export function ImportsProvider({ children }: { children: ReactNode }) {
  const store = useStore()
  const storeRef = useRef(store)
  storeRef.current = store
  const [items, setItems] = useState<Import[]>([])
  const stopped = useRef(new Set<string>())

  const patch = useCallback((id: string, fn: (i: Import) => Partial<Import>) => {
    setItems((all) => all.map((i) => (i.id === id ? { ...i, ...fn(i) } : i)))
  }, [])

  // one import at a time: many at once would only race for the same lookups
  const queue = useRef<Promise<void>>(Promise.resolve())

  const run = useCallback(
    (id: string, list: SpotifyList, opts: Opts, liked: boolean) => {
      patch(id, () => ({ phase: 'running' }))
      stopped.current.delete(id)
      const set = (k: number, st: TrackState) => patch(id, (i) => ({ states: i.states.map((x, j) => (j === k ? st : x)) }))
      queue.current = queue.current.then(async () => {
        const pid = liked ? null : storeRef.current.createPlaylist(list.name)
        for (let k = 0; k < list.tracks.length && !stopped.current.has(id); k++) {
          const t = list.tracks[k]
          try {
            set(k, 'cerco')
            const m = await engine.matchSong(t)
            const songId = `yt-${m.videoId}`
            if (storeRef.current.songs.some((s) => s.id === songId)) {
              set(k, 'già presente')
            } else {
              // only the entry: it streams like on Spotify, unless you asked to download it
              const artist = t.artist.split(',')[0].trim()
              const song = {
                id: songId,
                title: artist ? `${artist} – ${t.title}` : t.title,
                duration: t.duration || m.duration,
                stems: [],
                files: {},
                source: 'device' as const,
                addedAt: Date.now()
              }
              storeRef.current.addToLibrary(song, true)
              if (opts.download) storeRef.current.download([songId])
              if (opts.split) await storeRef.current.splitLater(song)
              set(k, 'fatto')
            }
            if (pid) storeRef.current.addToPlaylist(pid, [songId])
            else storeRef.current.updateSong(songId, { liked: true, likedAt: Date.now() })
          } catch {
            set(k, 'non trovata')
          }
        }
        patch(id, () => ({ phase: 'done' }))
        storeRef.current.showToast(t('Playlist “{name}” importata', { name: list.name }))
      })
    },
    [patch]
  )

  const newItem = (url: string, list: SpotifyList | null, liked = false): string => {
    const id = `imp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
    setItems((all) => [
      { id, url, list, error: null, states: list ? list.tracks.map(() => 'attesa' as TrackState) : [], phase: list ? 'ready' : 'loading', liked },
      ...all
    ])
    return id
  }

  const add = useCallback(
    (url: string, auto = false) => {
      const id = newItem(url, null)
      engine
        .playlistFromLink(url)
        .then((list) => {
          patch(id, () => ({ list, states: list.tracks.map(() => 'attesa' as TrackState), phase: 'ready' }))
          if (auto) run(id, list, { download: false, split: false }, false)
        })
        .catch((e) => patch(id, () => ({ error: errMsg(e), phase: 'done' })))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patch, run]
  )

  const addList = useCallback(
    (list: SpotifyList, o: { liked?: boolean; auto?: boolean } = {}) => {
      const id = newItem('', list, !!o.liked)
      if (o.auto) run(id, list, { download: false, split: false }, !!o.liked)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run]
  )

  const start = useCallback(
    (id: string, opts: Opts) => {
      const imp = items.find((i) => i.id === id)
      if (imp?.list) run(id, imp.list, opts, !!imp.liked)
    },
    [items, run]
  )

  // the phone must not sleep while importing
  const running = items.some((i) => i.phase === 'running')
  const wasRunning = useRef(false)
  useEffect(() => {
    if (!isNative || running === wasRunning.current) return
    wasRunning.current = running
    if (running) void KeepAwake.keepAwake().catch(() => undefined)
    else void KeepAwake.allowSleep().catch(() => undefined)
  }, [running])

  const value: Imports = {
    items,
    add,
    addList,
    start,
    stop: (id) => stopped.current.add(id),
    remove: (id) => setItems((all) => all.filter((i) => i.id !== id))
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
