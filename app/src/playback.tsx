import { KeepAwake } from '@capacitor-community/keep-awake'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { errMsg } from './lib/format'
import { Mixer } from './lib/mixer'
import { engine } from './lib/engine'
import { logListen } from './lib/listens'
import { isLocalPath, originalRef, youtubeIdOf } from './lib/media'
import { isNative } from './lib/native'
import { StemPlayer, type PlayerSpec } from './lib/player'
import { readAudio } from './lib/storage'
import { DEFAULT_MIX, type MixState, type Song } from './lib/types'
import { useStore } from './store'

/* App-wide playback, Spotify style: one song plays whatever screen you are on,
   with a "context" (the list it was started from) and a "queue" of songs added
   with "Metti in coda", which play first.

   What you hear is chosen automatically: with every stem on at 100% the
   original recording plays (best quality, starts at once); as soon as a stem
   is muted, soloed or its volume changed, the stems take over at the same
   point. On the phone this is the native engine (audio/Engine.java: streaming,
   stems kept in lockstep, next song preloaded); in a desktop browser (tests)
   a Web Audio fallback. */

export interface NowPlaying {
  songId: string
  contextIds: string[]
  contextName: string
  index: number // position in contextIds (for a queued song: the list song played before it)
  fromQueue: boolean
}

export type Source = 'original' | 'stems'

/** nothing muted or soloed, every volume at 100%: the stems add up to the original */
export function isNeutral(mix: MixState | undefined): boolean {
  if (!mix) return true
  return !mix.muted.length && !mix.solo.length && Object.values(mix.vols).every((v) => Math.abs((v ?? 1) - 1) < 0.005)
}

export function sourceFor(song: Song, mix: MixState): Source {
  if (!song.stems.length) return 'original'
  if (!originalRef(song)) return 'stems'
  return isNeutral(mix) ? 'original' : 'stems'
}

export type Repeat = 'off' | 'all' | 'one'

interface Playback {
  now: NowPlaying | null
  shuffle: boolean
  repeat: Repeat
  toggleShuffle(): void
  cycleRepeat(): void
  source: Source
  loading: boolean
  error: string | null
  playing: boolean
  duration: number
  mix: MixState
  queue: string[]
  stopAtEnd: boolean
  loop: { a: number; b: number } | null
  position(): number
  playList(ids: string[], index: number, name: string): void
  playSong(songId: string): void
  toggle(): void
  seek(t: number): void
  next(): void
  prev(): void
  setMix(m: MixState): void
  enqueue(songId: string): void
  dequeue(index: number): void
  setStopAtEnd(v: boolean): void
  setLoop(l: { a: number; b: number } | null): void
  /** sleep timer: wall-clock end (ms), or "end of song" */
  sleep: { at: number; atEnd: boolean }
  setSleep(minutes: number): void
  countingIn: boolean
}

const Ctx = createContext<Playback | null>(null)

export function usePlayback(): Playback {
  const p = useContext(Ctx)
  if (!p) throw new Error('playback missing')
  return p
}

function loadStopAtEnd(): boolean {
  try {
    return localStorage.getItem('stemkit:stopAtEnd') === '1'
  } catch {
    return false
  }
}

/* ------------------------------------------------------------- backends */

interface BackendEvents {
  state(s: {
    playing?: boolean
    loading?: boolean
    duration?: number
    source?: Source
    error?: string | null
    sleep?: { at: number; atEnd: boolean }
    countingIn?: boolean
  }): void
  ended(songId: string): void
  offset(songId: string, frames: number): void
  remote(action: 'next' | 'prev'): void
  /** the native engine moved to another song by itself */
  advanced(songId: string, dir: 'next' | 'prev'): void
}

interface Backend {
  /** countIn: the click before a song you start yourself (not when the same song is reloaded) */
  load(song: Song, mix: MixState, autoplay: boolean, startAt: number, countIn?: boolean): void
  preload(song: Song | null): void
  play(): void
  pause(): void
  seek(t: number): void
  setMix(song: Song, mix: MixState): void
  setLoop(l: { a: number; b: number } | null): void
  position(): number
  stop(): void
  dispose(): void
  /** native only: the engine owns next/previous so they work with the app asleep */
  native: boolean
  setUpcoming(next: Song[], prev: Song | null, autoAdvance: boolean, repeatOne: boolean): void
  next(): void
  prev(): void
}

/* streamed songs not fully cached yet: measured after they are played */
const notCached = new Set<string>()

/** Spotify-like loudness target */
const TARGET_LUFS = -14

export function gainFor(song: Song | undefined, normalize: boolean): number {
  if (!normalize || !song || typeof song.lufs !== 'number') return 0
  return Math.max(-12, Math.min(6, TARGET_LUFS - song.lufs))
}

let normalizeOn = true // read by nativeSpec (outside React)

/** a song for the alarm clock (it plays it natively, also with the app closed) */
export const alarmSpec = (song: Song): PlayerSpec => nativeSpec(song, song.mix ?? DEFAULT_MIX, 0, true)

function nativeSpec(song: Song, mix: MixState, startAt = 0, autoplay = true): PlayerSpec {
  const stems: Record<string, string> = {}
  for (const id of song.stems) {
    const f = song.files[id]
    if (f && !f.startsWith('bridge:')) stems[id] = f
  }
  return {
    songId: song.id,
    title: song.title,
    original: originalRef(song),
    stems,
    mix,
    offset: song.stemOffset ?? null,
    duration: song.duration || 0,
    startAt,
    autoplay,
    gainDb: gainFor(song, normalizeOn),
    bpm: song.bpm || 0
  }
}

function nativeBackend(ev: BackendEvents): Backend {
  // the engine reports its position ~7 times a second; in between, interpolate
  let last = { pos: 0, at: performance.now(), playing: false }
  let current: string | null = null
  let preloadedId: string | null = null
  const sub = StemPlayer.addListener('player', (e) => {
    if (e.type === 'remote' && e.action) return ev.remote(e.action)
    if (e.type === 'advanced' && e.songId && e.dir) {
      current = e.songId
      return ev.advanced(e.songId, e.dir)
    }
    if (e.type === 'offset' && e.songId && typeof e.offset === 'number') return ev.offset(e.songId, e.offset)
    if (e.type === 'ended') return // the engine itself moves on (or stops)
    if ((e.type === 'state' || e.type === 'tick') && e.songId === current) {
      last = { pos: e.pos ?? 0, at: performance.now(), playing: !!e.playing }
      ev.state({
        playing: !!e.playing,
        loading: !!e.loading,
        duration: e.dur && e.dur > 0 ? e.dur : undefined,
        source: e.source === 'original' || e.source === 'stems' ? e.source : undefined,
        error: e.error ?? null,
        sleep: { at: e.sleepAt ?? 0, atEnd: !!e.sleepAtEnd },
        countingIn: !!e.countIn
      })
    }
  })
  return {
    load(song, mix, autoplay, startAt, countIn = true) {
      current = song.id
      preloadedId = null
      last = { pos: startAt, at: performance.now(), playing: false }
      // a song you start yourself gets the count-in (songs that follow on their own don't)
      void StemPlayer.load({ ...nativeSpec(song, mix, startAt, autoplay), countIn }).catch((e) => ev.state({ error: errMsg(e), loading: false }))
    },
    preload(song) {
      if (!song || song.id === preloadedId || song.id === current) return
      preloadedId = song.id
      void StemPlayer.preload(nativeSpec(song, song.mix ?? DEFAULT_MIX)).catch(() => undefined)
    },
    play: () => void StemPlayer.play(),
    pause: () => void StemPlayer.pause(),
    seek(t) {
      last = { pos: t, at: performance.now(), playing: last.playing }
      void StemPlayer.seek({ t })
    },
    setMix: (_song, mix) => void StemPlayer.setMix({ mix }),
    setLoop: (l) => void StemPlayer.setLoop(l ? { a: l.a, b: l.b } : { a: -1, b: -1 }),
    position: () => (last.playing ? last.pos + (performance.now() - last.at) / 1000 : last.pos),
    stop: () => void StemPlayer.stop(),
    dispose: () => void sub.then((h) => h.remove()),
    native: true,
    setUpcoming(next, prev, autoAdvance, repeatOne) {
      void StemPlayer.setUpcoming({
        next: next.map((s) => nativeSpec(s, s.mix ?? DEFAULT_MIX)),
        previous: prev ? nativeSpec(prev, prev.mix ?? DEFAULT_MIX) : null,
        autoAdvance,
        repeatOne
      }).catch(() => undefined)
    },
    next: () => void StemPlayer.next(),
    prev: () => void StemPlayer.prev()
  }
}

/** Desktop-browser fallback (testing): decodes into memory with Web Audio. */
function webBackend(ev: BackendEvents, bridge: () => import('./lib/bridge').BridgeConfig | null): Backend {
  let ctx: AudioContext | null = null
  let mixer: Mixer | null = null
  let token = 0
  let pending: number | null = null
  let song: Song | null = null
  let src: Source = 'stems'
  let loop: { a: number; b: number } | null = null
  const audio = () => (ctx ??= new AudioContext({ latencyHint: 'playback' }))
  // the next song, fetched while this one plays
  const ahead = new Map<string, Promise<ArrayBuffer>>()
  const fetchAudio = (ref: string | undefined) => {
    const p = ref ? ahead.get(ref) : undefined
    if (p && ref) ahead.delete(ref)
    return p ?? readAudio(ref, bridge())
  }

  const open = async (s: Song, mix: MixState, autoplay: boolean, startAt: number) => {
    const my = ++token
    pending = startAt
    mixer?.dispose()
    const c = audio()
    if (autoplay) void c.resume()
    const m = new Mixer(c, mix)
    m.setGainDb(gainFor(s, true))
    mixer = m
    song = s
    src = sourceFor(s, mix)
    m.onEnded = () => {
      ev.state({ playing: false })
      ev.ended(s.id)
    }
    ev.state({ loading: true, playing: false, source: src, error: null })
    try {
      if (src === 'original') m.addStem('original', await c.decodeAudioData(await fetchAudio(originalRef(s))))
      else
        await Promise.all(
          s.stems.map(async (id) => {
            const buf = await c.decodeAudioData(await fetchAudio(s.files[id]))
            if (my === token) m.addStem(id, buf)
          })
        )
      if (my !== token) return
      if (startAt) m.seek(startAt)
      if (loop) m.setLoop(loop)
      pending = null
      ev.state({ loading: false, duration: m.duration })
      if (autoplay) {
        await m.play()
        ev.state({ playing: true })
      }
    } catch (e) {
      if (my === token) {
        pending = null
        ev.state({ loading: false, error: errMsg(e) })
      }
    }
  }

  return {
    load: (s, mix, autoplay, startAt) => {
      loop = null
      void open(s, mix, autoplay, startAt)
    },
    preload(s) {
      if (!s || sourceFor(s, s.mix ?? DEFAULT_MIX) !== 'original') return
      const ref = originalRef(s)
      if (!ref || ahead.has(ref)) return
      ahead.clear()
      const p = readAudio(ref, bridge())
      p.catch(() => ahead.delete(ref))
      ahead.set(ref, p)
    },
    play() {
      void audio().resume()
      void mixer?.play().then(() => ev.state({ playing: true }))
    },
    pause() {
      mixer?.pause()
      ev.state({ playing: false })
    },
    seek: (t) => mixer?.seek(t),
    setMix(s, mix) {
      // the web fallback has no lockstep engine: reload when the source changes
      if (song && sourceFor(s, mix) !== src) void open(s, mix, mixer?.isPlaying ?? false, mixer?.position ?? 0)
      else mixer?.setMix(mix)
    },
    setLoop(l) {
      loop = l
      mixer?.setLoop(l)
    },
    position: () => pending ?? mixer?.position ?? 0,
    stop() {
      token++
      mixer?.dispose()
      mixer = null
    },
    dispose() {
      mixer?.dispose()
      void ctx?.close()
    },
    native: false,
    setUpcoming: () => undefined,
    next: () => undefined,
    prev: () => undefined
  }
}

/* ------------------------------------------------------------- provider */

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const store = useStore()
  const storeRef = useRef(store)
  storeRef.current = store
  const [now, setNow] = useState<NowPlaying | null>(null)
  const nowRef = useRef<NowPlaying | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  const [source, setSource] = useState<Source>('original')
  const [mix, setMixState] = useState<MixState>(DEFAULT_MIX)
  const [queue, setQueue] = useState<string[]>([])
  const queueRef = useRef<string[]>([])
  const [stopAtEnd, setStopAtEndState] = useState(loadStopAtEnd)
  const stopAtEndRef = useRef(stopAtEnd)
  const [loop, setLoopState] = useState<{ a: number; b: number } | null>(null)
  const [sleep, setSleepState] = useState({ at: 0, atEnd: false })
  const [countingIn, setCountingIn] = useState(false)
  const [shuffle, setShuffle] = useState(false)
  const [repeat, setRepeatState] = useState<Repeat>('off')
  const repeatRef = useRef<Repeat>('off')
  const unshuffled = useRef<string[] | null>(null) // list order before "casuale"
  const backendRef = useRef<Backend | null>(null)
  const handlers = useRef<{ next(): void; prev(): void; again(): void; advanced(songId: string, dir: 'next' | 'prev'): void }>({
    next: () => undefined,
    prev: () => undefined,
    again: () => undefined,
    advanced: () => undefined
  })

  const setQueueBoth = (q: string[]) => {
    queueRef.current = q
    setQueue(q)
  }

  if (!backendRef.current) {
    const ev: BackendEvents = {
      state(s) {
        if (s.playing !== undefined) setPlaying(s.playing)
        if (s.loading !== undefined) setLoading(s.loading)
        if (s.duration !== undefined) setDuration(s.duration)
        if (s.source !== undefined) setSource(s.source)
        if (s.error !== undefined) setError(s.error)
        if (s.sleep !== undefined) setSleepState((o) => (o.at === s.sleep!.at && o.atEnd === s.sleep!.atEnd ? o : s.sleep!))
        if (s.countingIn !== undefined) setCountingIn(s.countingIn)
      },
      ended(songId) {
        if (nowRef.current?.songId !== songId) return
        setPlaying(false)
        if (repeatRef.current === 'one') return handlers.current.again()
        if (!stopAtEndRef.current) handlers.current.next()
      },
      offset(songId, frames) {
        storeRef.current.setStemOffset(songId, frames)
      },
      remote(action) {
        handlers.current[action]()
      },
      advanced(songId, dir) {
        handlers.current.advanced(songId, dir)
      }
    }
    backendRef.current = isNative ? nativeBackend(ev) : webBackend(ev, () => storeRef.current.bridgeCfg)
  }
  const backend = backendRef.current
  useEffect(() => () => backend.dispose(), [backend])

  /** the song after the current one: the queue first, then the list */
  const upcoming = (): Song | null => {
    const q = queueRef.current
    const cur = nowRef.current
    const id = q.length ? q[0] : cur && cur.index + 1 < cur.contextIds.length ? cur.contextIds[cur.index + 1] : null
    return id ? storeRef.current.getSong(id) ?? null : null
  }

  /** hand the engine what comes next (queue, then the list) and what came before */
  const syncUpcoming = useCallback(() => {
    if (!backend.native) return
    const byId = { get: (id: string) => storeRef.current.getSong(id) }
    const cur = nowRef.current
    if (!cur) return backend.setUpcoming([], null, !stopAtEndRef.current, repeatRef.current === 'one')
    // "ripeti tutto": after the end of the list, start again from the top
    const wrap = repeatRef.current === 'all' ? cur.contextIds.slice(0, cur.index + (cur.fromQueue ? 1 : 0)) : []
    const ids = [...queueRef.current, ...cur.contextIds.slice(cur.index + 1), ...wrap].slice(0, 30)
    const prevId = cur.fromQueue ? cur.contextIds[cur.index] : cur.index > 0 ? cur.contextIds[cur.index - 1] : null
    backend.setUpcoming(
      ids.map((id) => byId.get(id)).filter((s): s is Song => !!s),
      prevId && prevId !== cur.songId ? byId.get(prevId) ?? null : null,
      !stopAtEndRef.current,
      repeatRef.current === 'one'
    )
  }, [backend])

  /** the tracks the engine has for the song playing ("stems:files"): when they change, it reloads */
  const loadedTracks = useRef('')
  const loadedFor = useRef('') // the song those tracks belong to
  const tracksOf = (song: Song) => song.stems.map((id) => `${id}=${song.files[id] ?? ''}`).join(',') + `|${originalRef(song) ?? ''}`

  /** show a song as current without (re)loading it: the engine already plays it */
  const adopt = (np: NowPlaying) => {
    storeRef.current.updateSong(np.songId, { playedAt: Date.now() })
    const song = storeRef.current.getSong(np.songId)
    if (song) {
      loadedTracks.current = tracksOf(song)
      loadedFor.current = song.id
    }
    if (song) logListen(song.title)
    nowRef.current = np
    setNow(np)
    if (song) {
      const m = song.mix ?? DEFAULT_MIX
      setMixState(m)
      setDuration(song.duration || 0)
      setSource(sourceFor(song, m))
    }
    setLoopState(null)
    syncUpcoming()
  }

  const start = useCallback(
    (np: NowPlaying, autoplay = true, startAt = 0) => {
      const song = storeRef.current.getSong(np.songId)
      if (!song) return
      const m = song.mix ?? DEFAULT_MIX
      nowRef.current = np
      setNow(np)
      storeRef.current.updateSong(song.id, { playedAt: Date.now() })
      logListen(song.title)
      setMixState(m)
      setLoopState(null)
      setDuration(song.duration || 0)
      setSource(sourceFor(song, m))
      setError(null)
      setLoading(true)
      loadedTracks.current = tracksOf(song)
      loadedFor.current = song.id
      backend.load(song, m, autoplay, startAt)
      // the next one starts instantly when it comes (scaletta, coda)
      if (backend.native) syncUpcoming()
      else setTimeout(() => backend.preload(upcoming()), 1500)
      // the next one is preloaded whole; the ones after it get their streams looked up
      const cur = nowRef.current
      const after = [...queueRef.current, ...(cur ? cur.contextIds.slice(cur.index + 1) : [])].slice(1, 4)
      engine.warm(after.flatMap((id) => youtubeIdOf(id) ?? []))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [backend]
  )

  const playList = useCallback(
    (ids: string[], index: number, name: string) => start({ songId: ids[index], contextIds: ids, contextName: name, index, fromQueue: false }),
    [start]
  )

  const playSong = useCallback((songId: string) => start({ songId, contextIds: [songId], contextName: '', index: 0, fromQueue: false }), [start])

  const next = useCallback(() => {
    if (backend.native) return backend.next() // the engine answers with 'advanced'
    const q = queueRef.current
    const cur = nowRef.current
    if (q.length) {
      setQueueBoth(q.slice(1))
      const base = cur ?? { songId: q[0], contextIds: [q[0]], contextName: '', index: 0, fromQueue: false }
      start({ ...base, songId: q[0], fromQueue: true })
      return
    }
    if (!cur) return
    const n = cur.index + 1
    if (n < cur.contextIds.length) start({ ...cur, songId: cur.contextIds[n], index: n, fromQueue: false })
    else if (repeatRef.current === 'all' && cur.contextIds.length) start({ ...cur, songId: cur.contextIds[0], index: 0, fromQueue: false })
  }, [start, backend])

  const prev = useCallback(() => {
    if (backend.native) return backend.prev()
    const cur = nowRef.current
    if (!cur) return
    if (backend.position() > 3) {
      backend.seek(0)
      return
    }
    const p = cur.fromQueue ? cur.index : cur.index - 1
    if (p >= 0 && p < cur.contextIds.length) start({ ...cur, songId: cur.contextIds[p], index: p, fromQueue: false })
    else backend.seek(0)
  }, [start, backend])
  // the engine changed song on its own (end of song, notification, lock screen):
  // move the queue / list position the same way it did
  const advanced = (songId: string, dir: 'next' | 'prev') => {
    const cur = nowRef.current
    const q = queueRef.current
    if (!cur) return adopt({ songId, contextIds: [songId], contextName: '', index: 0, fromQueue: false })
    if (dir === 'next') {
      if (q.length && q[0] === songId) {
        setQueueBoth(q.slice(1))
        return adopt({ ...cur, songId, fromQueue: true })
      }
      if (cur.contextIds[cur.index + 1] === songId) return adopt({ ...cur, songId, index: cur.index + 1, fromQueue: false })
    } else {
      if (cur.fromQueue && cur.contextIds[cur.index] === songId) return adopt({ ...cur, songId, fromQueue: false })
      if (cur.contextIds[cur.index - 1] === songId) return adopt({ ...cur, songId, index: cur.index - 1, fromQueue: false })
    }
    const i = cur.contextIds.indexOf(songId)
    adopt(i >= 0 ? { ...cur, songId, index: i, fromQueue: false } : { songId, contextIds: [songId], contextName: '', index: 0, fromQueue: false })
  }
  const again = () => {
    const cur = nowRef.current
    if (cur) start(cur)
  }
  handlers.current = { next, prev, again, advanced }

  const toggleShuffle = () => {
    const cur = nowRef.current
    const on = !shuffle
    setShuffle(on)
    if (!cur) return
    let ctx: NowPlaying
    if (on) {
      unshuffled.current = cur.contextIds
      const rest = cur.contextIds.filter((_, i) => i !== cur.index)
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[rest[i], rest[j]] = [rest[j], rest[i]]
      }
      ctx = { ...cur, contextIds: [cur.contextIds[cur.index] ?? cur.songId, ...rest], index: 0 }
    } else {
      const orig = unshuffled.current ?? cur.contextIds
      const i = orig.indexOf(cur.fromQueue ? cur.contextIds[cur.index] : cur.songId)
      ctx = { ...cur, contextIds: orig, index: Math.max(0, i) }
      unshuffled.current = null
    }
    nowRef.current = ctx
    setNow(ctx)
    syncUpcoming()
  }

  const cycleRepeat = () => {
    const nextMode: Repeat = repeatRef.current === 'off' ? 'all' : repeatRef.current === 'all' ? 'one' : 'off'
    repeatRef.current = nextMode
    setRepeatState(nextMode)
    syncUpcoming()
  }

  const toggle = useCallback(() => {
    if (!nowRef.current || loading) return
    if (playing) {
      backend.pause()
      setPlaying(false)
    } else {
      backend.play()
      setPlaying(true)
    }
  }, [backend, loading, playing])

  // the song playing got its tracks (split while it played, or downloaded): the engine takes them
  // at the same point, so voice and instruments can be switched off at once
  const nowSong = now ? store.getSong(now.songId) : undefined
  const nowTracks = nowSong ? tracksOf(nowSong) : ''
  useEffect(() => {
    if (!backend.native || !nowSong || !nowTracks || nowTracks === loadedTracks.current) return
    const known = loadedFor.current === nowSong.id
    loadedTracks.current = nowTracks
    loadedFor.current = nowSong.id
    if (!known) return // a song taken over as it was (the app reopened while it played)
    if (!nowSong.stems.length) return
    backend.load(nowSong, mix, playing, backend.position(), false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowTracks])

  const setMix = useCallback(
    (m: MixState) => {
      setMixState(m)
      const cur = nowRef.current
      const song = cur && storeRef.current.getSong(cur.songId)
      if (!song) return
      backend.setMix(song, m)
      if (!isNative) setSource(sourceFor(song, m))
      storeRef.current.saveMix(song.id, m)
    },
    [backend]
  )

  const enqueue = useCallback(
    (songId: string) => {
      if (!nowRef.current) return playSong(songId)
      setQueueBoth([...queueRef.current, songId])
      if (backend.native) syncUpcoming()
      else if (queueRef.current.length === 1) backend.preload(upcoming())
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [playSong, backend]
  )

  const setLoop = useCallback(
    (l: { a: number; b: number } | null) => {
      setLoopState(l)
      backend.setLoop(l)
    },
    [backend]
  )

  // "volume uniforme": apply to the current song when the setting or its measurement changes
  normalizeOn = store.normalize
  useEffect(() => notCached.clear(), [now?.songId])
  const curSong = now ? store.getSong(now.songId) : undefined
  const curGain = gainFor(curSong, store.normalize)
  useEffect(() => {
    if (isNative && now) void StemPlayer.setGain({ db: curGain }).catch(() => undefined)
  }, [curGain, now])

  // background upkeep, one job at a time: loudness, artwork, tempo of every song
  const measuring = useRef<string | null>(null)
  useEffect(() => {
    if (!engine.available || !store.ready || measuring.current || store.deviceJob?.state === 'running') return
    const local = (p?: string) => (isLocalPath(p) ? p : null)
    const playable = (s: Song) => local(s.original) || s.stems.some((id) => local(s.files[id]))
    let job: (() => Promise<void>) | null = null
    let key = ''
    // streamed songs are measured once their first play has filled the cache
    const loud = store.songs.find((s) => s.lufs === undefined && (playable(s) || (youtubeIdOf(s.id) && !notCached.has(s.id))))
    const art = store.songs.find((s) => s.cover === undefined && youtubeIdOf(s.id))
    // the tempo needs the phone's detector; songs added on the PC get it once they are synced
    const tempo = isNative ? store.songs.find((s) => s.bpm === undefined && playable(s)) : undefined
    if (art) {
      key = `cover:${art.id}`
      job = () =>
        engine
          .fetchCover(art.id, youtubeIdOf(art.id)!)
          .then((path) => storeRef.current.updateSong(art.id, { cover: path }))
          .catch(() => storeRef.current.updateSong(art.id, { cover: '' }))
    } else if (loud) {
      key = `lufs:${loud.id}`
      const stems = loud.stems.map((id) => local(loud.files[id])).filter((p): p is string => !!p)
      const paths = local(loud.original) ? [loud.original!] : stems.length ? stems : [originalRef(loud)!]
      job = () =>
        engine.measureLoudness(paths).then((lufs) => {
          if (lufs === undefined) notCached.add(loud.id)
          else storeRef.current.setLufs(loud.id, typeof lufs === 'number' ? Math.round(lufs * 10) / 10 : null)
        })
          .catch(() => storeRef.current.setLufs(loud.id, null))
    } else if (tempo) {
      key = `bpm:${tempo.id}`
      const path = local(tempo.files.drums) ?? local(tempo.original) ?? local(tempo.files[tempo.stems[0]])!
      job = () =>
        StemPlayer.detectBpm({ path })
          .then((r) => storeRef.current.updateSong(tempo.id, { bpm: typeof r.bpm === 'number' ? r.bpm : 0 }))
          .catch(() => storeRef.current.updateSong(tempo.id, { bpm: 0 }))
    }
    if (!job) return
    measuring.current = key
    const run = job
    const t = setTimeout(
      () =>
        void run().finally(() => {
          measuring.current = null
        }),
      key.startsWith('cover:') ? 100 : 1200
    )
    return () => {
      if (measuring.current === key) {
        clearTimeout(t)
        measuring.current = null
      }
    }
  }, [store.songs, store.ready, store.deviceJob?.state])

  useEffect(() => {
    if (isNative) void StemPlayer.setCountIn({ beats: store.countIn }).catch(() => undefined)
  }, [store.countIn])

  // keep the phone awake while music plays (on stage the screen must not lock)
  useEffect(() => {
    if (!isNative) return
    if (playing) void KeepAwake.keepAwake().catch(() => undefined)
    else if (!store.playerOpen) void KeepAwake.allowSleep().catch(() => undefined)
  }, [playing, store.playerOpen])

  // a deleted song can't stay loaded or queued
  useEffect(() => {
    const ids = new Set(store.allSongs.map((s) => s.id))
    if (queueRef.current.some((q) => !ids.has(q))) setQueueBoth(queueRef.current.filter((q) => ids.has(q)))
    if (nowRef.current && !ids.has(nowRef.current.songId)) {
      backend.stop()
      nowRef.current = null
      setNow(null)
      setPlaying(false)
    }
  }, [store.allSongs, backend])

  const value: Playback = {
    now,
    shuffle,
    repeat,
    toggleShuffle,
    cycleRepeat,
    source,
    loading,
    error,
    playing,
    duration,
    mix,
    queue,
    stopAtEnd,
    loop,
    position: () => backend.position(),
    playList,
    playSong,
    toggle,
    seek: (t) => backend.seek(Math.max(0, t)),
    next,
    prev,
    setMix,
    enqueue,
    dequeue: (i) => {
      setQueueBoth(queueRef.current.filter((_, k) => k !== i))
      syncUpcoming()
    },
    setStopAtEnd: (v) => {
      stopAtEndRef.current = v
      setStopAtEndState(v)
      syncUpcoming()
      try {
        localStorage.setItem('stemkit:stopAtEnd', v ? '1' : '0')
      } catch {
        /* ignore */
      }
    },
    setLoop,
    sleep,
    setSleep: (minutes) => {
      if (isNative) void StemPlayer.setSleep({ minutes })
      setSleepState({ at: minutes > 0 ? Date.now() + minutes * 60000 : 0, atEnd: minutes < 0 })
    },
    countingIn
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
