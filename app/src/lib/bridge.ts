import type { PcJob, PcSong, SearchResult, StemId } from './types'

export interface BridgeConfig {
  address: string // "192.168.1.36:8777"
  pin: string
}

export function bridgeBase(address: string): string {
  const a = address.trim().replace(/\/+$/, '')
  const withScheme = /^https?:\/\//.test(a) ? a : `http://${a}`
  return /:\d+$/.test(withScheme) ? withScheme : `${withScheme}:8777`
}

/* Client for bridge/stemkit_bridge.py running on the PC. */
export class Bridge {
  readonly base: string
  constructor(readonly cfg: BridgeConfig) {
    this.base = bridgeBase(cfg.address)
  }

  private async req<T>(path: string, init: RequestInit = {}, timeoutMs = 15000): Promise<T> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(this.base + path, {
        ...init,
        signal: ctrl.signal,
        headers: { 'X-StemKit-Pin': this.cfg.pin, ...(init.headers ?? {}) }
      })
      const text = await res.text()
      let data: unknown = null
      try {
        data = JSON.parse(text)
      } catch {
        /* not json */
      }
      if (!res.ok) {
        const msg = (data as { error?: string } | null)?.error
        throw new Error(msg || `Errore ${res.status}`)
      }
      return data as T
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new Error('Il PC non risponde')
      if (e instanceof TypeError) throw new Error('PC non raggiungibile: il Bridge è acceso e sei sulla stessa rete?')
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  auth(): Promise<{ ok: boolean; name: string }> {
    return this.req('/api/auth', {}, 6000)
  }

  async songs(): Promise<PcSong[]> {
    return (await this.req<{ songs: PcSong[] }>('/api/songs')).songs
  }

  async jobs(): Promise<PcJob[]> {
    return (await this.req<{ jobs: PcJob[] }>('/api/jobs')).jobs
  }

  async search(q: string): Promise<SearchResult[]> {
    return (await this.req<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(q)}`, {}, 60000)).results
  }

  resolve(url: string): Promise<{ kind: 'youtube'; url: string } | { kind: 'search'; query: string }> {
    return this.req('/api/resolve', { method: 'POST', body: JSON.stringify({ url }), headers: { 'Content-Type': 'application/json' } }, 30000)
  }

  async startYoutube(url: string, stems: StemId[]): Promise<PcJob> {
    return (
      await this.req<{ job: PcJob }>('/api/jobs/youtube', {
        method: 'POST',
        body: JSON.stringify({ url, stems }),
        headers: { 'Content-Type': 'application/json' }
      })
    ).job
  }

  async cancel(jobId: string): Promise<void> {
    await this.req(`/api/jobs/${jobId}`, { method: 'DELETE' })
  }

  uploadUrl(stems: StemId[]): string {
    return `${this.base}/api/jobs/upload?stems=${stems.join(',')}`
  }

  stemPath(songId: string, stem: StemId, ext: 'flac' | 'm4a' = 'm4a'): string {
    return `/api/songs/${encodeURIComponent(songId)}/stems/${stem}.${ext}`
  }

  originalPath(songId: string, ext: 'flac' | 'm4a' = 'm4a'): string {
    return `/api/songs/${encodeURIComponent(songId)}/original.${ext}`
  }
}
