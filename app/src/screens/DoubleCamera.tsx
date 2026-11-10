import { ArrowLeftRight, Camera, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useBackHandler } from '../components/ui'
import { errMsg } from '../lib/format'
import { t } from '../lib/i18n'
import { nameParts } from '../lib/media'
import { StemKitNative } from '../lib/native'
import { fileUrl } from '../lib/storage'
import { Directory, Filesystem } from '@capacitor/filesystem'
import type { Song } from '../lib/types'

/* The camera of a song's memories, like BeReal: the phone's own camera app (its
   zoom, its quality) for the back photo, then again for the front one; a template
   puts them together. "Una sola" keeps a single photo. */

type Template = 'corner' | 'circle' | 'split' | 'side' | 'back' | 'front'
const TEMPLATES: Array<[Template, string]> = [
  ['corner', 'Riquadro'],
  ['circle', 'Cerchio'],
  ['split', 'Sopra e sotto'],
  ['side', 'Affiancate'],
  ['back', 'Solo dietro'],
  ['front', 'Solo davanti']
]
const TPL_KEY = 'stemkit:photo-template'
const W = 1080
const H = 1440 // 3:4, portrait

/** draws an image to fill a box, cropping what sticks out */
function cover(g: CanvasRenderingContext2D, img: HTMLCanvasElement, x: number, y: number, w: number, h: number) {
  const s = Math.max(w / img.width, h / img.height)
  const sw = w / s
  const sh = h / s
  g.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h)
}

/** the two shots put together in a template */
function compose(back: HTMLCanvasElement | null, front: HTMLCanvasElement | null, tpl: Template, swap: boolean): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  g.fillStyle = '#000'
  g.fillRect(0, 0, W, H)
  const main = swap ? front : back
  const small = swap ? back : front
  const inset = (shape: 'rect' | 'circle') => {
    if (!small) return
    const w = shape === 'circle' ? 380 : 360
    const h = shape === 'circle' ? 380 : 480
    const x = shape === 'circle' ? W - w - 40 : 40
    const y = shape === 'circle' ? H - h - 40 : 40
    g.save()
    g.beginPath()
    if (shape === 'circle') g.arc(x + w / 2, y + h / 2, w / 2, 0, Math.PI * 2)
    else g.roundRect(x, y, w, h, 36)
    g.closePath()
    g.lineWidth = 12
    g.strokeStyle = '#fff'
    g.stroke()
    g.clip()
    cover(g, small, x, y, w, h)
    g.restore()
  }
  if (tpl === 'back' && back) cover(g, back, 0, 0, W, H)
  else if (tpl === 'front' && front) cover(g, front, 0, 0, W, H)
  else if (tpl === 'split') {
    if (main) cover(g, main, 0, 0, W, H / 2)
    if (small) cover(g, small, 0, H / 2, W, H / 2)
    g.fillStyle = '#fff'
    g.fillRect(0, H / 2 - 4, W, 8)
  } else if (tpl === 'side') {
    if (main) cover(g, main, 0, 0, W / 2, H)
    if (small) cover(g, small, W / 2, 0, W / 2, H)
    g.fillStyle = '#fff'
    g.fillRect(W / 2 - 4, 0, 8, H)
  } else {
    if (main) cover(g, main, 0, 0, W, H)
    inset(tpl === 'circle' ? 'circle' : 'rect')
  }
  return c
}

/** a saved photo, as a canvas (to put it in a template) */
function load(file: string): Promise<HTMLCanvasElement> {
  return new Promise((ok, fail) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      c.getContext('2d')!.drawImage(img, 0, 0)
      ok(c)
    }
    img.onerror = () => fail(new Error('foto non leggibile'))
    img.src = fileUrl(file) ?? ''
  })
}

const PLACE_KEY = 'stemkit:photo-place'
const MODE_KEY = 'stemkit:photo-double'

export function DoubleCamera({
  song,
  onDone,
  onClose
}: {
  song: Song
  /** withPlace: add where you are now to the photo */
  onDone: (p: { file: string; at: number }, withPlace: boolean) => void
  onClose: () => void
}) {
  useBackHandler(onClose)
  const [double, setDouble] = useState(() => {
    try {
      return localStorage.getItem(MODE_KEY) !== '0'
    } catch {
      return true
    }
  })
  const [phase, setPhase] = useState<'start' | 'review'>('start')
  const [files, setFiles] = useState<{ back?: string; front?: string }>({})
  const [shots, setShots] = useState<{ back: HTMLCanvasElement | null; front: HTMLCanvasElement | null }>({ back: null, front: null })
  const [tpl, setTpl] = useState<Template>(() => {
    try {
      return (localStorage.getItem(TPL_KEY) as Template) || 'corner'
    } catch {
      return 'corner'
    }
  })
  const [swap, setSwap] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [withPlace, setWithPlace] = useState(() => {
    try {
      return localStorage.getItem(PLACE_KEY) !== '0'
    } catch {
      return true
    }
  })
  const preview = useRef<HTMLCanvasElement>(null)

  const drop = (f?: string) => {
    if (f) void Filesystem.deleteFile({ path: f, directory: Directory.Data }).catch(() => undefined)
  }
  const shoot = async () => {
    setErr(null)
    setBusy(true)
    try {
      localStorage.setItem(MODE_KEY, double ? '1' : '0')
    } catch {
      /* private mode */
    }
    try {
      const back = await StemKitNative.takePhoto({ songId: song.id })
      // the front one: cancelled, one photo is fine
      const front = double ? await StemKitNative.takePhoto({ songId: song.id, front: true }).catch(() => null) : null
      setFiles({ back: back.file, front: front?.file })
      setShots({ back: await load(back.file), front: front ? await load(front.file) : null })
      if (!front) setTpl('back')
      else if (tpl === 'back' || tpl === 'front') setTpl('corner')
      setPhase('review')
    } catch (e) {
      const m = errMsg(e)
      if (m !== 'Annullato') setErr(m)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    void shoot() // straight to the camera, like the phone's
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // the review: the template drawn as you pick it
  useEffect(() => {
    if (phase !== 'review' || !preview.current) return
    const c = compose(shots.back, shots.front, tpl, swap)
    const p = preview.current
    p.width = c.width
    p.height = c.height
    p.getContext('2d')!.drawImage(c, 0, 0)
  }, [phase, shots, tpl, swap])

  const save = async () => {
    setBusy(true)
    try {
      localStorage.setItem(TPL_KEY, tpl)
      localStorage.setItem(PLACE_KEY, withPlace ? '1' : '0')
    } catch {
      /* private mode */
    }
    try {
      // one photo as it is (no re-compression); two in their template
      if (!shots.front && files.back && tpl === 'back') return onDone({ file: files.back, at: Date.now() }, withPlace)
      const data = compose(shots.back, shots.front, tpl, swap).toDataURL('image/jpeg', 0.9)
      const saved = await StemKitNative.savePhotoData({ songId: song.id, data })
      drop(files.back)
      drop(files.front)
      onDone(saved, withPlace)
    } catch (e) {
      setErr(errMsg(e))
      setBusy(false)
    }
  }
  const close = () => {
    drop(files.back)
    drop(files.front)
    onClose()
  }
  const again = () => {
    drop(files.back)
    drop(files.front)
    setFiles({})
    setShots({ back: null, front: null })
    setSwap(false)
    setPhase('start')
    void shoot()
  }
  const both = !!shots.back && !!shots.front

  return (
    <div className="dcam">
      <header className="lyrics-full-head">
        <button className="icon-btn" onClick={close} aria-label={t('Chiudi')}>
          <ChevronDown />
        </button>
        <span>
          <b>{phase === 'review' ? t('Scegli come comporla') : double ? t('Doppia foto') : t('Foto')}</b>
          <small>{nameParts(song.title).name}</small>
        </span>
        <span style={{ width: 44 }} />
      </header>
      <div className="dcam-view">
        {phase === 'review' ? (
          <canvas ref={preview} />
        ) : (
          <div className="dcam-start">
            <p>{double ? t('Prima la foto dietro, poi quella davanti (se riparte dietro, girala col pulsante della fotocamera).') : t('Una foto con la fotocamera del telefono.')}</p>
            {err && <p className="dcam-err-inline">{err}</p>}
          </div>
        )}
      </div>
      {phase === 'start' && (
        <footer className="dcam-bar">
          <button className={`dcam-mode ${double ? 'on' : ''}`} onClick={() => setDouble(!double)}>
            {double ? t('Doppia') : t('Una sola')}
          </button>
          <button className="dcam-shutter" disabled={busy} onClick={() => void shoot()} aria-label={t('Scatta')}>
            <Camera />
          </button>
          <span style={{ minWidth: 96 }} />
        </footer>
      )}
      {phase === 'review' && (
        <footer className="dcam-review">
          {both && (
            <div className="chips">
              {TEMPLATES.map(([k, label]) => (
                <button key={k} className={tpl === k ? 'active' : ''} onClick={() => setTpl(k)}>
                  {t(label)}
                </button>
              ))}
              {tpl !== 'back' && tpl !== 'front' && (
                <button onClick={() => setSwap(!swap)}>
                  <ArrowLeftRight /> {t('Scambia')}
                </button>
              )}
            </div>
          )}
          <label className="switch-row">
            <span>{t('Aggiungi dove sono adesso')}</span>
            <input type="checkbox" checked={withPlace} onChange={(e) => setWithPlace(e.target.checked)} />
          </label>
          {err && <p className="dcam-err-inline">{err}</p>}
          <div className="dcam-actions">
            <button onClick={again}>{t('Rifai')}</button>
            <button className="primary" disabled={busy} onClick={() => void save()}>
              {t('Salva nei ricordi')}
            </button>
          </div>
        </footer>
      )}
    </div>
  )
}
