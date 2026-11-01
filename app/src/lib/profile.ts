import { useSyncExternalStore } from 'react'

/* The profile (Profilo): your name (also the one the Jam shows, so it is never asked
   again) and where you are. Kept on this device. */

export interface Profile {
  name: string
  location: string
}

const KEY = 'stemkit:profile'
const subs = new Set<() => void>()

function read(): Profile {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Profile> | null
    // the name typed for a Jam before the profile existed
    const old = localStorage.getItem('stemkit:jam-name') ?? ''
    return { name: p?.name ?? old, location: p?.location ?? '' }
  } catch {
    return { name: '', location: '' }
  }
}

let current = read()

export const getProfile = () => current

export function setProfile(p: Partial<Profile>) {
  current = { ...current, ...p }
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    /* private mode */
  }
  subs.forEach((f) => f())
}

export function useProfile(): Profile {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => current
  )
}
