import { bridgeBase, type BridgeConfig } from './bridge'
import { youtubeIdOf } from './media'
import { StemKitNative } from './native'
import { songFiles, type Deleted, type PcState } from './storage'
import type { FollowedArtist, Playlist, Song } from './types'

/* Phone ⇄ PC: the phone sends its library to the bridge, which merges it with
   the PC's (bridge/pc_app.py merge_in: newer copy wins, deletions travel as
   tombstones) and answers with the result plus the PC's file list. Then the
   files missing on either side are copied. */

type Item = { id: string; updatedAt?: number }

/** same rule as merge_items on the PC: the newer copy wins, keeping fields only the other has */
export function mergeItems<T extends Item>(base: T[], incoming: T[], tomb: Record<string, number>): T[] {
  const by = new Map(base.map((x) => [x.id, x]))
  const order = base.map((x) => x.id)
  for (const x of incoming) {
    const cur = by.get(x.id)
    if (!cur) {
      by.set(x.id, x)
      order.push(x.id)
    } else if ((x.updatedAt ?? 0) >= (cur.updatedAt ?? 0)) by.set(x.id, { ...cur, ...x })
    else by.set(x.id, { ...x, ...cur })
  }
  return order.map((id) => by.get(id)!).filter((x) => !(x.id in tomb) || (tomb[x.id] ?? 0) < (x.updatedAt ?? 0))
}

export function mergeDeleted(a: Deleted, b: Deleted): Deleted {
  const one = (x: Record<string, number>, y: Record<string, number>) => {
    const out = { ...x }
    for (const [k, v] of Object.entries(y ?? {})) out[k] = Math.max(out[k] ?? 0, v)
    return out
  }
  return { songs: one(a.songs ?? {}, b.songs ?? {}), playlists: one(a.playlists ?? {}, b.playlists ?? {}) }
}

export interface SyncProgress {
  done: number
  total: number
}

export interface SyncResult {
  state: PcState
  /** songs whose audio is on the phone now */
  ready: Set<string>
  name: string
}

async function req<T>(cfg: BridgeConfig, path: string, init: RequestInit = {}, ms = 30000): Promise<T> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(bridgeBase(cfg.address) + path, { ...init, signal: ctrl.signal, headers: { 'X-StemKit-Pin': cfg.pin } })
    const data = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (!res.ok) throw new Error(data.error || `Errore ${res.status}`)
    return data
  } finally {
    clearTimeout(t)
  }
}

export const pingPc = (cfg: BridgeConfig) => req<{ ok: boolean; name: string }>(cfg, '/api/auth', {}, 2500)

/**
 * The PC moved to another address (DHCP): look for the bridge on the same
 * network and check it knows our PIN.
 */
export async function findPc(cfg: BridgeConfig): Promise<BridgeConfig | null> {
  const m = cfg.address.match(/^(?:https?:\/\/)?(\d+\.\d+\.\d+)\.(\d+)(?::(\d+))?/)
  if (!m) return null
  const port = m[3] ?? '8778'
  const hosts = Array.from({ length: 254 }, (_, i) => i + 1).filter((h) => String(h) !== m[2])
  for (let i = 0; i < hosts.length; i += 64) {
    const found = await Promise.any(
      hosts.slice(i, i + 64).map(async (h) => {
        const c = { address: `https://${m[1]}.${h}:${port}`, pin: cfg.pin, fingerprint: cfg.fingerprint }
        await pingPc(c)
        return c
      })
    ).catch(() => null)
    if (found) return found
  }
  return null
}

/** one full sync; the caller applies {state, ready} to the library */
export async function syncWithPc(
  cfg: BridgeConfig,
  local: { songs: Song[]; playlists: Playlist[]; artists: FollowedArtist[]; deleted: Deleted },
  onProgress: (p: SyncProgress) => void
): Promise<SyncResult> {
  const { name } = await pingPc(cfg)
  const state = await req<PcState>(
    cfg,
    '/api/sync',
    { method: 'POST', body: JSON.stringify({ device: 'phone', songs: local.songs, playlists: local.playlists, artists: local.artists, deleted: local.deleted }) },
    60000
  )
  const mine = (await StemKitNative.listFiles()).files
  const base = bridgeBase(cfg.address)
  const up: string[] = []
  const down: string[] = []
  for (const s of state.songs) {
    // split songs travel whole; a listen-only song arrives as a stream (only its artwork is copied)
    const files = s.stems.length ? [...songFiles(s), ...(s.cover ? [s.cover] : [])] : s.cover ? [s.cover] : []
    for (const f of files) {
      if (f in mine && !(f in state.files)) up.push(f)
      else if (!(f in mine) && f in state.files) down.push(f)
    }
  }
  const total = up.length + down.length
  let done = 0
  onProgress({ done, total })
  const jobs = [
    ...up.map((f) => () => StemKitNative.pushFile({ id: `sync:${f}`, path: f, url: `${base}/api/lib/file/${f}`, pin: cfg.pin, fingerprint: cfg.fingerprint }).then(() => (mine[f] = 1))),
    ...down.map(
      (f) => () => StemKitNative.download({ id: `sync:${f}`, url: `${base}/api/lib/file/${f}`, pin: cfg.pin, fingerprint: cfg.fingerprint, path: f }).then(() => (mine[f] = 1))
    )
  ]
  // two transfers at a time; one failure doesn't stop the rest (retried next sync)
  let next = 0
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]
      await job().catch(() => undefined)
      onProgress({ done: ++done, total })
    }
  }
  await Promise.all([worker(), worker()])
  for (const s of state.songs) {
    // the PC's download of a listen-only song is not this phone's: here it streams
    if (!s.stems.length && s.original && !(s.original in mine)) delete s.original
    if (s.cover && !(s.cover in mine)) delete s.cover
  }
  const ready = new Set(
    state.songs.filter((s) => (s.stems.length ? songFiles(s).every((f) => f in mine) : !!s.original || !!youtubeIdOf(s.id))).map((s) => s.id)
  )
  return { state, ready, name }
}
