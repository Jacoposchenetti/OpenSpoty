import { Directory, Filesystem } from '@capacitor/filesystem'
import { Camera, ChevronDown, ImagePlus, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useBackHandler } from '../components/ui'
import { errMsg } from '../lib/format'
import { localeTag, t } from '../lib/i18n'
import { nameParts } from '../lib/media'
import { StemKitNative } from '../lib/native'
import { fileUrl } from '../lib/storage'
import type { Song, SongPhoto } from '../lib/types'
import { useStore } from '../store'

/* Memories: photos taken with a song (the camera next to "Suona"). A stack of
   them floats over the player, wherever you drag it; a tap opens them all,
   newest first, each with its date and a note. */

const POS_KEY = 'stemkit:photo-pos'

function loadPos(): { x: number; y: number } {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null') as { x: number; y: number } | null
    if (p && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) return p
  } catch {
    /* private mode */
  }
  return { x: 0.78, y: 0.2 }
}

/** add a photo to the song (kept in the library: a memory is worth keeping) */
export function usePhotoActions(song: Song) {
  const store = useStore()
  const save = (photos: SongPhoto[]) => {
    if (store.songs.some((s) => s.id === song.id)) store.updateSong(song.id, { photos })
    else store.addToLibrary({ ...song, photos }, true)
  }
  const current = () => store.getSong(song.id)?.photos ?? song.photos ?? []
  const add = async (how: 'camera' | 'gallery') => {
    try {
      const p = how === 'camera' ? await StemKitNative.takePhoto({ songId: song.id }) : await StemKitNative.pickPhoto({ songId: song.id })
      save([{ file: p.file, at: p.at }, ...current()])
      store.showToast(t('Foto aggiunta ai ricordi di questa canzone'))
    } catch (e) {
      const m = errMsg(e)
      if (m !== 'Annullato') store.showToast(m)
    }
  }
  const remove = async (file: string) => {
    save(current().filter((p) => p.file !== file))
    await Filesystem.deleteFile({ path: file, directory: Directory.Data }).catch(() => undefined)
  }
  const note = (file: string, text: string) => save(current().map((p) => (p.file === file ? { ...p, note: text.trim() || undefined } : p)))
  return { add, remove, note }
}

/** the stack over the player: drag it anywhere, tap it to open the photos */
export function PhotoStack({ song }: { song: Song }) {
  const photos = song.photos ?? []
  const [pos, setPos] = useState(loadPos)
  const [open, setOpen] = useState(false)
  const drag = useRef<{ x0: number; y0: number; moved: boolean; box: DOMRect } | null>(null)
  if (!photos.length) return null
  const top = photos[0]
  const src = fileUrl(top.file) ?? ''
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
          <img src={src} alt="" draggable={false} />
        </span>
        {photos.length > 1 && <span className="photo-count">{photos.length}</span>}
      </button>
      {open && createPortal(<PhotoGallery song={song} onClose={() => setOpen(false)} />, document.body)}
    </>
  )
}

/** every photo of the song, newest first, with its date and a note */
function PhotoGallery({ song, onClose }: { song: Song; onClose: () => void }) {
  useBackHandler(onClose)
  const store = useStore()
  const live = store.getSong(song.id) ?? song
  const photos = live.photos ?? []
  const act = usePhotoActions(live)
  const [deleting, setDeleting] = useState<string | null>(null)
  const when = new Intl.DateTimeFormat(localeTag(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  const { name, artist } = nameParts(song.title)
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
        {!photos.length && <p className="muted center">{t('Nessuna foto: scattane una.')}</p>}
        {photos.map((p) => (
          <figure key={p.file} className="photo-item">
            <img src={fileUrl(p.file) ?? ''} alt="" loading="lazy" />
            <figcaption>
              <span className="photo-date">{when.format(new Date(p.at))}</span>
              <textarea
                defaultValue={p.note ?? ''}
                placeholder={t('Aggiungi una nota (dove, con chi…)')}
                rows={2}
                onBlur={(e) => e.target.value !== (p.note ?? '') && act.note(p.file, e.target.value)}
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
        <button className="primary" onClick={() => void act.add('camera')}>
          <Camera /> {t('Scatta')}
        </button>
        <button onClick={() => void act.add('gallery')}>
          <ImagePlus /> {t('Dalla galleria')}
        </button>
      </footer>
    </div>
  )
}
