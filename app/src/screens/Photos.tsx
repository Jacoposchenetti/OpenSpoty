import { Directory, Filesystem } from '@capacitor/filesystem'
import { Camera, ChevronDown, ImagePlus, LocateFixed, MapPin, Trash2 } from 'lucide-react'
import { useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Sheet, useBackHandler } from '../components/ui'
import { errMsg } from '../lib/format'
import { localeTag, t } from '../lib/i18n'
import { nameParts } from '../lib/media'
import { StemKitNative } from '../lib/native'
import { fileUrl } from '../lib/storage'
import type { Song, SongPhoto } from '../lib/types'
import { useStore } from '../store'
import { DoubleCamera } from './DoubleCamera'
import { defaultDetails, DetailsFields, here, resolvePlace, type Details } from './MemoryDetails'

/* Memories: photos with a song (the camera next to "Suona": a shot, or one from
   the gallery). A stack of them floats over the player, wherever you drag it; a tap
   opens them all, newest first, each with its date, a note and where it was taken.
   They can be hidden from the player's ⋮. */

const POS_KEY = 'stemkit:photo-pos'
const HIDE_KEY = 'stemkit:memories-hidden'

/* ------------------------------------------------------------ shown or hidden */

const subs = new Set<() => void>()
let hidden = (() => {
  try {
    return localStorage.getItem(HIDE_KEY) === '1'
  } catch {
    return false
  }
})()

export function setMemoriesHidden(v: boolean) {
  hidden = v
  try {
    localStorage.setItem(HIDE_KEY, v ? '1' : '0')
  } catch {
    /* private mode */
  }
  subs.forEach((f) => f())
}

export const useMemoriesHidden = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => hidden
  )

/* ------------------------------------------------------------ the photos of a song */

function loadPos(): { x: number; y: number } {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null') as { x: number; y: number } | null
    if (p && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) return p
  } catch {
    /* private mode */
  }
  return { x: 0.78, y: 0.2 }
}

/** the song's photos, kept with it (a song with memories stays in the library) */
export function usePhotoActions(song: Song) {
  const store = useStore()
  const current = () => store.getSong(song.id)?.photos ?? song.photos ?? []
  const save = (photos: SongPhoto[]) => {
    if (store.songs.some((s) => s.id === song.id)) store.updateSong(song.id, { photos })
    else store.addToLibrary({ ...song, photos }, true)
  }
  const added = (p: SongPhoto) => {
    save([p, ...current()])
    store.showToast(t('Foto aggiunta ai ricordi di questa canzone'))
  }
  const fromGallery = async () => {
    try {
      const p = await StemKitNative.pickPhoto({ songId: song.id })
      added({ file: p.file, at: p.at, place: p.place })
    } catch (e) {
      const m = errMsg(e)
      if (m !== 'Annullato') store.showToast(m)
    }
  }
  /** a photo picked but not kept */
  const discard = (file: string) => Filesystem.deleteFile({ path: file, directory: Directory.Data }).catch(() => undefined)
  const remove = async (file: string) => {
    save(current().filter((p) => p.file !== file))
    await Filesystem.deleteFile({ path: file, directory: Directory.Data }).catch(() => undefined)
  }
  const patch = (file: string, x: Partial<SongPhoto>) => save(current().map((p) => (p.file === file ? { ...p, ...x } : p)))
  return { added, fromGallery, remove, patch, discard }
}

/** the camera button: a double photo, a single one, or one from the gallery; then a note and the place */
export function PhotoAdd({ song, onClose }: { song: Song; onClose: () => void }) {
  const store = useStore()
  const act = usePhotoActions(song)
  const [camera, setCamera] = useState<'double' | 'single' | null>(null)
  const [picked, setPicked] = useState<{ file: string; at: number; place?: SongPhoto['place'] } | null>(null)
  const keep = async (p: { file: string; at: number }, d: Details) => {
    act.added({ file: p.file, at: p.at, note: d.note.trim() || undefined, place: await resolvePlace(d) })
    onClose()
  }
  if (camera) return createPortal(<DoubleCamera song={song} double={camera === 'double'} onDone={(p, d) => void keep(p, d)} onClose={onClose} />, document.body)
  if (picked) return <GalleryDetails photo={picked} onSave={(d) => void keep(picked, d)} onCancel={() => (void act.discard(picked.file), onClose())} />
  const gallery = async () => {
    try {
      setPicked(await StemKitNative.pickPhoto({ songId: song.id }))
    } catch (e) {
      const m = errMsg(e)
      if (m !== 'Annullato') store.showToast(m)
      onClose()
    }
  }
  return (
    <Sheet title={t('Aggiungi un ricordo')} onClose={onClose}>
      <button onClick={() => setCamera('double')}>
        <Camera /> {t('Doppia foto (dietro e davanti)')}
      </button>
      <button onClick={() => setCamera('single')}>
        <Camera /> {t('Una foto')}
      </button>
      <button onClick={() => void gallery()}>
        <ImagePlus /> {t('Dalla galleria')}
      </button>
    </Sheet>
  )
}

/** a photo from the gallery: the note and the place (read from it, when the phone noted it) before saving */
function GalleryDetails({ photo, onSave, onCancel }: { photo: { file: string; place?: SongPhoto['place'] }; onSave: (d: Details) => void; onCancel: () => void }) {
  const [d, setD] = useState<Details>(() => defaultDetails(photo.place))
  return (
    <Sheet title={t('Il ricordo')} onClose={onCancel}>
      <img className="mem-preview" src={fileUrl(photo.file) ?? ''} alt="" />
      <DetailsFields value={d} onChange={setD} />
      <button className="primary" onClick={() => onSave(d)}>
        {t('Salva nei ricordi')}
      </button>
    </Sheet>
  )
}

/** the stack over the player: drag it anywhere, tap it to open the photos */
export function PhotoStack({ song }: { song: Song }) {
  const photos = song.photos ?? []
  const [pos, setPos] = useState(loadPos)
  const [open, setOpen] = useState(false)
  const drag = useRef<{ x0: number; y0: number; moved: boolean; box: DOMRect } | null>(null)
  if (!photos.length) return null
  const top = photos[0]
  const down = (e: React.PointerEvent<HTMLButtonElement>) => {
    const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
    drag.current = { x0: e.clientX, y0: e.clientY, moved: false, box }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 8) return
    d.moved = true
    setPos({ x: Math.min(1, Math.max(0, (e.clientX - d.box.left) / d.box.width)), y: Math.min(1, Math.max(0, (e.clientY - d.box.top) / d.box.height)) })
  }
  const up = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.moved) {
      try {
        localStorage.setItem(POS_KEY, JSON.stringify(pos))
      } catch {
        /* private mode */
      }
    } else setOpen(true)
  }
  return (
    <>
      <button
        className={`photo-stack ${photos.length > 1 ? 'many' : ''}`}
        style={{ left: `${pos.x * 100}%`, top: `${pos.y * 100}%` }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => (drag.current = null)}
        aria-label={t('Ricordi di questa canzone ({count})', { count: photos.length })}
      >
        {photos.length > 2 && <span className="photo-card back2" />}
        {photos.length > 1 && <span className="photo-card back1" />}
        <span className="photo-card front">
          <img src={fileUrl(top.file) ?? ''} alt="" draggable={false} />
        </span>
        {photos.length > 1 && <span className="photo-count">{photos.length}</span>}
      </button>
      {open && createPortal(<PhotoGallery song={song} onClose={() => setOpen(false)} />, document.body)}
    </>
  )
}

/** every photo of the song, newest first, with its date, a note and where it was taken */
function PhotoGallery({ song, onClose }: { song: Song; onClose: () => void }) {
  useBackHandler(onClose)
  const store = useStore()
  const live = store.getSong(song.id) ?? song
  const photos = live.photos ?? []
  const act = usePhotoActions(live)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [placing, setPlacing] = useState<SongPhoto | null>(null)
  const [adding, setAdding] = useState(false)
  const when = new Intl.DateTimeFormat(localeTag(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  const { name, artist } = nameParts(song.title)
  const mapUrl = (p: NonNullable<SongPhoto['place']>) =>
    p.lat !== undefined && p.lon !== undefined
      ? `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name ?? '')}`
  return (
    <div className="photo-gallery">
      <header className="lyrics-full-head">
        <button className="icon-btn" onClick={onClose} aria-label={t('Chiudi')}>
          <ChevronDown />
        </button>
        <span>
          <b>{t('Ricordi')}</b>
          <small>
            {name}
            {artist ? ` · ${artist}` : ''}
          </small>
        </span>
        <span style={{ width: 44 }} />
      </header>
      <div className="photo-list">
        {!photos.length && <p className="muted center">{t('Nessuna foto: aggiungine una.')}</p>}
        {photos.map((p) => (
          <figure key={p.file} className="photo-item">
            <img src={fileUrl(p.file) ?? ''} alt="" loading="lazy" />
            <figcaption>
              <span className="photo-date">{when.format(new Date(p.at))}</span>
              {p.place ? (
                <span className="photo-place">
                  <MapPin />
                  <a href={mapUrl(p.place)} target="_blank" rel="noopener noreferrer">
                    {p.place.name || t('Posizione sulla mappa')}
                  </a>
                  <button className="link" onClick={() => setPlacing(p)}>
                    {t('Cambia')}
                  </button>
                </span>
              ) : (
                <button className="link photo-place-add" onClick={() => setPlacing(p)}>
                  <MapPin /> {t('Aggiungi il luogo')}
                </button>
              )}
              <textarea
                defaultValue={p.note ?? ''}
                placeholder={t('Aggiungi una nota (con chi, cosa stava succedendo…)')}
                rows={2}
                onBlur={(e) => e.target.value !== (p.note ?? '') && act.patch(p.file, { note: e.target.value.trim() || undefined })}
              />
              {deleting === p.file ? (
                <span className="photo-del">
                  <button className="danger" onClick={() => (void act.remove(p.file), setDeleting(null))}>
                    {t('Sì, elimina')}
                  </button>
                  <button onClick={() => setDeleting(null)}>{t('Annulla')}</button>
                </span>
              ) : (
                <button className="icon-btn" onClick={() => setDeleting(p.file)} aria-label={t('Elimina la foto')}>
                  <Trash2 />
                </button>
              )}
            </figcaption>
          </figure>
        ))}
      </div>
      <footer className="photo-actions">
        <button className="primary" onClick={() => setAdding(true)}>
          <Camera /> {t('Aggiungi un ricordo')}
        </button>
      </footer>
      {adding && <PhotoAdd song={live} onClose={() => setAdding(false)} />}
      {placing && <PlaceSheet photo={placing} onSave={(place) => act.patch(placing.file, { place })} onClose={() => setPlacing(null)} />}
    </div>
  )
}

/** where a photo was taken: typed, or where you are now */
function PlaceSheet({ photo, onSave, onClose }: { photo: SongPhoto; onSave: (p: SongPhoto['place']) => void; onClose: () => void }) {
  const [name, setName] = useState(photo.place?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const now = async () => {
    setBusy(true)
    setErr(null)
    const p = await here()
    setBusy(false)
    if (!p) return setErr(t('Posizione non trovata: scrivi il luogo.'))
    onSave(p)
    onClose()
  }
  return (
    <Sheet title={t('Dove è stata scattata')} onClose={onClose}>
      <button onClick={() => void now()} disabled={busy}>
        <LocateFixed /> {busy ? t('Cerco la tua posizione…') : t('Dove sono adesso')}
      </button>
      <input value={name} placeholder={t('Oppure scrivi il luogo (es. Lucca Summer Festival)')} onChange={(e) => setName(e.target.value)} />
      <button className="primary" disabled={!name.trim()} onClick={() => (onSave({ name: name.trim() }), onClose())}>
        {t('Salva')}
      </button>
      {photo.place && (
        <button className="danger" onClick={() => (onSave(undefined), onClose())}>
          {t('Togli il luogo')}
        </button>
      )}
      {err && <p className="muted small">{err}</p>}
    </Sheet>
  )
}
