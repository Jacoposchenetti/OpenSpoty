import { ArrowLeftRight, ChevronDown, SwitchCamera } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useBackHandler } from '../components/ui'
import { errMsg } from '../lib/format'
import { t } from '../lib/i18n'
import { nameParts } from '../lib/media'
import { StemKitNative } from '../lib/native'
import type { Song } from '../lib/types'

/* The camera of a song's memories, like BeReal: the back camera, then (a moment to
   pose) the front one — two cameras at once work on few phones — and a template
   puts them together. "Una sola" takes a single photo. */

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

/** a frame of the video, as a canvas */
function grab(v: HTMLVideoElement): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = v.videoWidth
  c.height = v.videoHeight
  c.getContext('2d')!.drawImage(v, 0, 0)
  return c
}

const PLACE_KEY = 'stemkit:photo-place'

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
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const [facing, setFacing] = useState<'environment' | 'user'>('environment')
  const [double, setDouble] = useState(true)
  const [phase, setPhase] = useState<'live' | 'second' | 'review'>('live')
  const [count, setCount] = useState(0)
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
  const [saving, setSaving] = useState(false)
  const [withPlace, setWithPlace] = useState(() => {
    try {
      return localStorage.getItem(PLACE_KEY) !== '0'
    } catch {
      return true
    }
  })
  const preview = useRef<HTMLCanvasElement>(null)

  const stop = () => {
    stream.current?.getTracks().forEach((x) => x.stop())
    stream.current = null
  }
  const open = async (f: 'environment' | 'user') => {
    stop()
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: f, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false })
      stream.current = s
      if (video.current) {
        video.current.srcObject = s
        await video.current.play().catch(() => undefined)
      }
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error && e.name === 'NotAllowedError' ? t('Serve il permesso della fotocamera') : t('Fotocamera non disponibile'))
    }
  }
  useEffect(() => {
    void open('environment')
    return stop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const ready = () => !!video.current && video.current.videoWidth > 0
  const shoot = async () => {
    if (!ready()) return
    const first = grab(video.current!)
    const wasBack = facing === 'environment'
    if (!double) {
      setShots(wasBack ? { back: first, front: null } : { back: null, front: first })
      setTpl(wasBack ? 'back' : 'front')
      stop()
      setPhase('review')
      return
    }
    // the other camera, after a moment to pose
    const other = wasBack ? 'user' : 'environment'
    setPhase('second')
    setFacing(other)
    await open(other)
    for (let n = 3; n > 0; n--) {
      setCount(n)
      await new Promise((r) => setTimeout(r, 700))
    }
    setCount(0)
    await new Promise((r) => setTimeout(r, 150))
    const second = ready() ? grab(video.current!) : null
    setShots(wasBack ? { back: first, front: second } : { back: second, front: first })
    if (tpl === 'back' || tpl === 'front') setTpl('corner')
    stop()
    setPhase('review')
  }

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
    setSaving(true)
    try {
      localStorage.setItem(TPL_KEY, tpl)
      localStorage.setItem(PLACE_KEY, withPlace ? '1' : '0')
    } catch {
      /* private mode */
    }
    try {
      const data = compose(shots.back, shots.front, tpl, swap).toDataURL('image/jpeg', 0.88)
      onDone(await StemKitNative.savePhotoData({ songId: song.id, data }), withPlace)
    } catch (e) {
      setErr(errMsg(e))
      setSaving(false)
    }
  }
  const again = () => {
    setShots({ back: null, front: null })
    setSwap(false)
    setFacing('environment')
    setPhase('live')
    void open('environment')
  }
  const both = !!shots.back && !!shots.front

  return (
    <div className="dcam">
      <header className="lyrics-full-head">
        <button className="icon-btn" onClick={onClose} aria-label={t('Chiudi')}>
          <ChevronDown />
        </button>
        <span>
          <b>{phase === 'review' ? t('Scegli come comporla') : double ? t('Doppia foto') : t('Foto')}</b>
          <small>{nameParts(song.title).name}</small>
        </span>
        <span style={{ width: 44 }} />
      </header>
      <div className="dcam-view">
        {phase !== 'review' && <video ref={video} playsInline muted className={facing === 'user' ? 'mirror' : ''} />}
        {phase === 'review' && <canvas ref={preview} />}
        {phase === 'second' && <div className="dcam-count">{count || ''}</div>}
        {phase === 'second' && <div className="dcam-hint">{facing === 'user' ? t('Ora tu!') : t('Ora dietro!')}</div>}
        {err && <p className="dcam-err">{err}</p>}
      </div>
      {phase === 'live' && (
        <footer className="dcam-bar">
          <button className={`dcam-mode ${double ? 'on' : ''}`} onClick={() => setDouble(!double)}>
            {double ? t('Doppia') : t('Una sola')}
          </button>
          <button className="dcam-shutter" onClick={() => void shoot()} aria-label={t('Scatta')} />
          <button
            className="dcam-mode"
            onClick={() => {
              const f = facing === 'environment' ? 'user' : 'environment'
              setFacing(f)
              void open(f)
            }}
            aria-label={t('Cambia fotocamera')}
          >
            <SwitchCamera />
          </button>
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
          <div className="dcam-actions">
            <button onClick={again}>{t('Rifai')}</button>
            <button className="primary" disabled={saving} onClick={() => void save()}>
              {t('Salva nei ricordi')}
            </button>
          </div>
        </footer>
      )}
    </div>
  )
}
