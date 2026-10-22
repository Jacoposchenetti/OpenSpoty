import { GripVertical, Music, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { fileUrl } from '../lib/storage'
import { STEM_META, type Song } from '../lib/types'

/* ---------------------------------------------------------------- back button
   Android's back button closes the top-most open thing first (a sheet, the
   full player, a playlist...). Overlays register a handler while mounted. */

const backStack: Array<() => void> = []

export function useBackHandler(onBack: (() => void) | null) {
  const ref = useRef(onBack)
  ref.current = onBack
  useEffect(() => {
    if (!onBack) return
    const fn = () => ref.current?.()
    backStack.push(fn)
    return () => {
      const i = backStack.lastIndexOf(fn)
      if (i >= 0) backStack.splice(i, 1)
    }
  }, [onBack === null]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** @return true if something handled the back press */
export function popBack(): boolean {
  const fn = backStack.pop()
  if (!fn) return false
  fn()
  return true
}

/* ---------------------------------------------------------------- sheet */

export function Sheet({ title, onClose, children }: { title?: ReactNode; onClose: () => void; children: ReactNode }) {
  useBackHandler(onClose)
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        {title && <div className="sheet-title">{title}</div>}
        {children}
      </div>
    </div>
  )
}

export function PromptSheet({
  title,
  initial = '',
  placeholder,
  confirm,
  onDone,
  onClose
}: {
  title: string
  initial?: string
  placeholder?: string
  confirm: string
  onDone: (value: string) => void
  onClose: () => void
}) {
  const [v, setV] = useState(initial)
  const ok = v.trim().length > 0
  return (
    <Sheet title={title} onClose={onClose}>
      <input
        autoFocus
        value={v}
        placeholder={placeholder}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && ok && (onDone(v.trim()), onClose())}
        enterKeyHint="done"
      />
      <button className="primary" disabled={!ok} onClick={() => (onDone(v.trim()), onClose())}>
        {confirm}
      </button>
    </Sheet>
  )
}

/* ---------------------------------------------------------------- artwork */

/** YouTube video id behind a song, when it came from YouTube */
export function youtubeId(song: Pick<Song, 'id'>): string | null {
  const m = song.id.match(/^(?:yt|pc)-([\w-]{11})$/)
  return m ? m[1] : null
}

function hue(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360
  return h
}

export function SongThumb({ song, size = 48 }: { song: Pick<Song, 'id' | 'title' | 'cover' | 'art'>; size?: number }) {
  const id = youtubeId(song)
  const [failed, setFailed] = useState(0)
  const style = { width: size, height: size }
  const local = song.cover ? fileUrl(song.cover) : null // saved on the phone: works offline
  const remote = song.art || (id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null)
  const src = local && failed < 1 ? local : remote && failed < 2 ? remote : null
  if (src) {
    return <img className="thumb" style={style} src={src} alt="" loading="lazy" onError={() => setFailed((f) => (local && f < 1 ? 1 : 2))} />
  }
  const h = hue(song.title)
  return (
    <span className="thumb ph" style={{ ...style, background: `linear-gradient(135deg, hsl(${h} 60% 45%), hsl(${(h + 60) % 360} 55% 30%))` }}>
      <Music />
    </span>
  )
}

/** a spinning ring: something is loading */
export function Spinner({ size = 18 }: { size?: number }) {
  return <LoaderCircle className="spin spinner" style={{ width: size, height: size }} aria-label="Caricamento" />
}

export function StemDots({ stems }: { stems: Song['stems'] }) {
  return (
    <span className="dots">
      {stems.map((s) => (
        <i key={s} style={{ background: STEM_META[s].color }} title={STEM_META[s].label} />
      ))}
    </span>
  )
}

/* ---------------------------------------------------------------- drag & drop list */

interface SortableProps<T> {
  items: T[]
  keyOf: (item: T, index: number) => string
  onMove: (from: number, to: number) => void
  render: (item: T, index: number, handle: ReactNode) => ReactNode
}

/** Touch drag-and-drop: hold the grip handle and drag the row up or down. */
export function SortableList<T>({ items, keyOf, onMove, render }: SortableProps<T>) {
  const rows = useRef<Array<HTMLDivElement | null>>([])
  const [drag, setDrag] = useState<{ from: number; to: number; dy: number } | null>(null)
  const st = useRef<{
    from: number
    startY: number
    pointerY: number
    startScroll: number
    rects: DOMRect[]
    scroller: HTMLElement | null
    raf: number
    to: number
  } | null>(null)

  const update = () => {
    const s = st.current
    if (!s) return
    const scroll = s.scroller ? s.scroller.scrollTop - s.startScroll : 0
    const dy = s.pointerY - s.startY + scroll
    const r = s.rects[s.from]
    const center = r.top + r.height / 2 + dy
    let to = s.from
    for (let j = s.from + 1; j < s.rects.length; j++) if (center > s.rects[j].top + s.rects[j].height / 2) to = j
    for (let j = s.from - 1; j >= 0; j--) if (center < s.rects[j].top + s.rects[j].height / 2) to = j
    s.to = to
    setDrag({ from: s.from, to, dy })
  }

  const autoScroll = () => {
    const s = st.current
    if (!s) return
    if (s.scroller) {
      const box = s.scroller.getBoundingClientRect()
      if (s.pointerY < box.top + 70) s.scroller.scrollTop -= 10
      else if (s.pointerY > box.bottom - 70) s.scroller.scrollTop += 10
    }
    update()
    s.raf = requestAnimationFrame(autoScroll)
  }

  const start = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault()
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* pointer already gone */
    }
    const scroller = rows.current[i]?.closest('.content') as HTMLElement | null
    st.current = {
      from: i,
      to: i,
      startY: e.clientY,
      pointerY: e.clientY,
      startScroll: scroller?.scrollTop ?? 0,
      rects: rows.current.slice(0, items.length).map((r) => r!.getBoundingClientRect()),
      scroller,
      raf: 0
    }
    navigator.vibrate?.(12)
    setDrag({ from: i, to: i, dy: 0 })
    st.current.raf = requestAnimationFrame(autoScroll)
  }
  const move = (e: React.PointerEvent) => {
    if (st.current) st.current.pointerY = e.clientY
  }
  const end = (e: React.PointerEvent) => {
    const s = st.current
    if (!s) return
    s.pointerY = e.clientY
    update() // the drop position, even if no animation frame ran since the last move
    cancelAnimationFrame(s.raf)
    st.current = null
    setDrag(null)
    if (s.to !== s.from) onMove(s.from, s.to)
  }

  const shift = (i: number): string | undefined => {
    if (!drag) return undefined
    const h = st.current?.rects[drag.from]?.height ?? 0
    if (i === drag.from) return `translateY(${drag.dy}px)`
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return `translateY(${-h}px)`
    if (drag.from > drag.to && i >= drag.to && i < drag.from) return `translateY(${h}px)`
    return undefined
  }

  return (
    <div className={drag ? 'sortable dragging' : 'sortable'}>
      {items.map((item, i) => (
        <div
          key={keyOf(item, i)}
          ref={(el) => {
            rows.current[i] = el
          }}
          className={drag?.from === i ? 'sort-row lifted' : 'sort-row'}
          style={{ transform: shift(i) }}
        >
          {render(
            item,
            i,
            <span className="handle" onPointerDown={start(i)} onPointerMove={move} onPointerUp={end} onPointerCancel={end} aria-label="Trascina per spostare">
              <GripVertical />
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
