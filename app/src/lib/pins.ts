import { useSyncExternalStore } from 'react'

/* Tools pinned to the bar at the bottom (from Home): by default only Home, Libreria, Cerca. */

export type Tool = 'tuner' | 'alarm' | 'capture'
const KEY = 'stemkit:pinned'
const subs = new Set<() => void>()

let pinned: Tool[] = (() => {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? '[]') as Tool[]).filter((x) => ['tuner', 'alarm', 'capture'].includes(x))
  } catch {
    return []
  }
})()

export function togglePin(t: Tool) {
  pinned = pinned.includes(t) ? pinned.filter((x) => x !== t) : [...pinned, t]
  try {
    localStorage.setItem(KEY, JSON.stringify(pinned))
  } catch {
    /* private mode */
  }
  subs.forEach((f) => f())
}

export function usePinned(): Tool[] {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => pinned
  )
}
