import { LocateFixed, MapPin } from 'lucide-react'
import { t } from '../lib/i18n'
import { StemKitNative } from '../lib/native'
import type { SongPhoto } from '../lib/types'

/* The details asked before a memory is saved (and editable later): a note, and
   where it was — read from the photo, where you are now, or typed. */

export interface Details {
  note: string
  useHere: boolean
  placeText: string
  /** the place found in the photo itself (gallery photos) */
  found?: SongPhoto['place']
}

const HERE_KEY = 'stemkit:photo-place'

/** how a place read from a photo is shown in the field (its name, or a placeholder) */
const foundLabel = (p: NonNullable<SongPhoto['place']>) => p.name ?? t('Luogo della foto')

export const defaultDetails = (found?: SongPhoto['place']): Details => {
  let here = true
  try {
    here = localStorage.getItem(HERE_KEY) !== '0'
  } catch {
    /* private mode */
  }
  return { note: '', useHere: found ? false : here, placeText: found ? foundLabel(found) : '', found }
}

/** where you are now, for a photo ({name, lat, lon}); null if it can't be found */
export async function here(): Promise<SongPhoto['place'] | null> {
  try {
    const p = await StemKitNative.locate()
    return { name: [p.name, p.region].filter(Boolean).join(', ') || undefined, lat: p.lat, lon: p.lon }
  } catch {
    return null
  }
}

/** the place the details stand for */
export async function resolvePlace(d: Details): Promise<SongPhoto['place'] | undefined> {
  try {
    localStorage.setItem(HERE_KEY, d.useHere ? '1' : '0')
  } catch {
    /* private mode */
  }
  if (d.useHere) return (await here()) ?? (d.placeText.trim() ? { name: d.placeText.trim() } : undefined)
  const typed = d.placeText.trim()
  if (!typed) return undefined
  return d.found && typed === foundLabel(d.found) ? d.found : { name: typed }
}

export function DetailsFields({ value, onChange }: { value: Details; onChange: (d: Details) => void }) {
  return (
    <div className="mem-details">
      <textarea
        value={value.note}
        rows={2}
        placeholder={t('Aggiungi una nota (con chi, cosa stava succedendo…)')}
        onChange={(e) => onChange({ ...value, note: e.target.value })}
      />
      <label className="switch-row">
        <span>
          <LocateFixed /> {t('Aggiungi dove sono adesso')}
        </span>
        <input type="checkbox" checked={value.useHere} onChange={(e) => onChange({ ...value, useHere: e.target.checked })} />
      </label>
      {!value.useHere && (
        <label className="mem-place">
          <MapPin />
          <input
            value={value.placeText}
            placeholder={t('Oppure scrivi il luogo (es. Lucca Summer Festival)')}
            onChange={(e) => onChange({ ...value, placeText: e.target.value })}
          />
        </label>
      )}
      {value.found && !value.useHere && value.placeText === foundLabel(value.found) && <small className="muted">{t('Luogo letto dalla foto')}</small>}
    </div>
  )
}
