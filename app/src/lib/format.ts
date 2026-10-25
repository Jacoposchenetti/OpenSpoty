import { t } from './i18n'

/** "3:07", and with the hours past an hour: "1:04:40" */
export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const ss = s.toString().padStart(2, '0')
  return h ? `${h}:${m.toString().padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return t(e.message)
  if (typeof e === 'object' && e && 'message' in e) return t(String((e as { message: unknown }).message))
  return t(String(e))
}
