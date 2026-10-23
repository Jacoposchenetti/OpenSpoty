import { registerPlugin } from '@capacitor/core'
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
  save(o: { alarms: Array<Alarm & { specs: PlayerSpec[] }> }): Promise<AlarmState>
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
  volume: 0.6,
  fadeSec: 45,
  snooze: 9
})

export const DAY_NAMES = ['L', 'M', 'M', 'G', 'V', 'S', 'D']

export function daysLabel(days: number[]): string {
  if (!days.length) return 'Una volta'
  const s = [...days].sort().join('')
  if (s === '1234567') return 'Tutti i giorni'
  if (s === '12345') return 'Lun–ven'
  if (s === '67') return 'Weekend'
  const full = ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom']
  return [...days].sort().map((d) => full[d - 1]).join(', ')
}

export const pad = (n: number) => String(n).padStart(2, '0')

export const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre']
const WEEKDAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato']

export const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const fromIso = (s: string) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** "venerdì 30 ottobre" (with the year when it isn't this one) */
export function dateLabel(iso: string): string {
  const d = fromIso(iso)
  const year = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : ''
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${year}`
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
  if (!h) return `tra ${m} minut${m === 1 ? 'o' : 'i'}`
  return `tra ${h} or${h === 1 ? 'a' : 'e'}${m ? ` e ${m} minut${m === 1 ? 'o' : 'i'}` : ''}`
}
