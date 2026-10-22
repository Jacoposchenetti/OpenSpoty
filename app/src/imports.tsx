import { KeepAwake } from '@capacitor-community/keep-awake'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { engine, type SpotifyList } from './lib/engine'
import { errMsg } from './lib/format'
import { isNative } from './lib/native'
import { useStore } from './store'

/* Spotify playlists / albums being imported: several at once, and they keep
   going while you use the rest of the app. */

export type TrackState = 'attesa' | 'cerco' | 'scarico' | 'fatto' | 'già presente' | 'non trovata'

export interface Import {
  id: string
  url: string
  list: SpotifyList | null
  error: string | null
  states: TrackState[]
  phase: 'loading' | 'ready' | 'running' | 'done'
}

interface Imports {
  items: Import[]
  add(url: string): void
  start(id: string, opts: { download: boolean; split: boolean }): void
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

  const add = useCallback(
    (url: string) => {
      const id = `imp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
      setItems((all) => [{ id, url, list: null, error: null, states: [], phase: 'loading' }, ...all])
      engine
        .spotifyList(url)
        .then((list) => patch(id, () => ({ list, states: list.tracks.map(() => 'attesa' as TrackState), phase: 'ready' })))
        .catch((e) => patch(id, () => ({ error: errMsg(e), phase: 'done' })))
    },
    [patch]
  )

  const start = useCallback(
    (id: string, opts: { download: boolean; split: boolean }) => {
      const imp = items.find((i) => i.id === id)
      const list = imp?.list
      if (!list) return
      patch(id, () => ({ phase: 'running' }))
      stopped.current.delete(id)
      const set = (k: number, st: TrackState) => patch(id, (i) => ({ states: i.states.map((x, j) => (j === k ? st : x)) }))
      void (async () => {
        const pid = storeRef.current.createPlaylist(list.name)
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
            storeRef.current.addToPlaylist(pid, [songId])
          } catch {
            set(k, 'non trovata')
          }
        }
        patch(id, () => ({ phase: 'done' }))
        storeRef.current.showToast(`Playlist “${list.name}” importata`)
      })()
    },
    [items, patch]
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
    start,
    stop: (id) => stopped.current.add(id),
    remove: (id) => setItems((all) => all.filter((i) => i.id !== id))
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
