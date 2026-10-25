import { registerPlugin } from '@capacitor/core'
import { localeTag, t } from './i18n'
import type { PlayerSpec } from './player'
import { readCacheJson, writeCacheJson } from './storage'

/* "Sveglia": alarms that wake you with your music. The list lives here
   (alarms.json); each save hands Android the alarms with the songs to play
   (AlarmClock.java), so they ring with the app closed and after a restart. */

export interface AlarmContent {
  kind: 'all' | 'liked' | 'playlist' | 'song' | 'album' | 'artist'
  id: string // playlist id, song id or Spotify uri ('' for all / liked)
  name: string
  image?: string
}

export interface Alarm {
  id: string
  hour: number
  minute: number
  days: number[] // 1 = Monday … 7 = Sunday; empty = once
  date?: string // YYYY-MM-DD: rings on that day only (the days are ignored)
  enabled: boolean
  label: string
  content: AlarmContent
  shuffle: boolean
  /** when its songs are over: again from the first, similar songs, or silence (old alarms: again) */
  after?: 'repeat' | 'similar' | 'stop'
  volume: number // 0..1 of the media volume
  fadeSec: number // from silence to full volume
  snooze: number // minutes
}

export interface AlarmState {
  next: { id: string; at: number } | null
  ringing: { id: string; label: string; hour: number; minute: number; snooze: number } | null
  fullScreen: boolean
}

interface AlarmsPlugin {
  save(o: { alarms: Array<Alarm & { specs: PlayerSpec[]; more: PlayerSpec[] }> }): Promise<AlarmState>
  state(): Promise<AlarmState>
  stop(): Promise<void>
  snooze(): Promise<void>
  allowFullScreen(): Promise<void>
}

export const Alarms = registerPlugin<AlarmsPlugin>('Alarms')

export const loadAlarms = async () => (await readCacheJson<Alarm[]>('alarms.json')) ?? []
export const saveAlarmList = (a: Alarm[]) => writeCacheJson('alarms.json', a)

export const newAlarm = (): Alarm => ({
  id: `al-${Date.now().toString(36)}`,
  hour: 7,
  minute: 30,
  days: [1, 2, 3, 4, 5],
  enabled: true,
  label: '',
  content: { kind: 'liked', id: '', name: 'Brani che ti piacciono' },
  shuffle: true,
  after: 'repeat',
  volume: 0.6,
  fadeSec: 45,
  snooze: 9
})

export const dayNames = () => Array.from({ length: 7 }, (_, index) =>
  new Intl.DateTimeFormat(localeTag(), { weekday: 'short' }).format(new Date(2024, 0, 1 + index))
)

export function daysLabel(days: number[]): string {
  if (!days.length) return t('Una volta')
  const s = [...days].sort().join('')
  if (s === '1234567') return t('Tutti i giorni')
  if (s === '12345') return t('Lun–ven')
  if (s === '67') return t('Weekend')
  const full = Array.from({ length: 7 }, (_, index) =>
    new Intl.DateTimeFormat(localeTag(), { weekday: 'short' }).format(new Date(2024, 0, 1 + index))
  )
  return [...days].sort().map((d) => full[d - 1]).join(', ')
}

export const pad = (n: number) => String(n).padStart(2, '0')

export const months = () => Array.from({ length: 12 }, (_, index) =>
  new Intl.DateTimeFormat(localeTag(), { month: 'long' }).format(new Date(2024, index, 1))
)

export const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const fromIso = (s: string) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** "venerdì 30 ottobre" (with the year when it isn't this one) */
export function dateLabel(iso: string): string {
  const d = fromIso(iso)
  const year = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : ''
  const date = new Intl.DateTimeFormat(localeTag(), { weekday: 'long', day: 'numeric', month: 'long' }).format(d)
  return `${date}${year}`
}

/** when an alarm rings, in words */
export const whenLabel = (a: Alarm) => (a.date ? dateLabel(a.date) : daysLabel(a.days))

/** a dated alarm whose moment is gone */
export const isPast = (a: Alarm) => {
  if (!a.date) return false
  const d = fromIso(a.date)
  d.setHours(a.hour, a.minute)
  return d.getTime() <= Date.now()
}

/** "tra 7 ore e 12 minuti" */
export function inWords(at: number): string {
  const min = Math.max(1, Math.round((at - Date.now()) / 60000))
  const h = Math.floor(min / 60), m = min % 60
  if (localeTag() === 'en-US') return h ? `in ${h} hour${h === 1 ? '' : 's'}${m ? ` and ${m} minute${m === 1 ? '' : 's'}` : ''}` : `in ${m} minute${m === 1 ? '' : 's'}`
  if (!h) return `tra ${m} minut${m === 1 ? 'o' : 'i'}`
  return `tra ${h} or${h === 1 ? 'a' : 'e'}${m ? ` e ${m} minut${m === 1 ? 'o' : 'i'}` : ''}`
}
