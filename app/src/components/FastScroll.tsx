import { useEffect, useRef, useState } from 'react'

/* The bar to run through a long list, like Spotify's: thin and grey while the
   list scrolls, then light blue while you hold it and drag. It drives the
   page's scroller (.content), so it goes anywhere inside a page. */

const THUMB = 48 // px
const PAD = 8

export function FastScroll() {
  const anchor = useRef<HTMLSpanElement>(null)
  const scroller = useRef<HTMLElement | null>(null)
  const dragging = useRef(false)
  const hide = useRef<number | undefined>(undefined)
  const [pos, setPos] = useState<{ frac: number; top: number; height: number; right: number } | null>(null)
  const [show, setShow] = useState(false)
  const [drag, setDrag] = useState(false)

  const later = () => {
    clearTimeout(hide.current)
    hide.current = window.setTimeout(() => !dragging.current && setShow(false), 1200)
  }

  useEffect(() => {
    const sc = anchor.current?.closest('.content') as HTMLElement | null
    if (!sc) return
    scroller.current = sc
    const onScroll = () => {
      const max = sc.scrollHeight - sc.clientHeight
      // short lists don't need it
      if (max < sc.clientHeight * 1.5) return setPos(null)
      const r = sc.getBoundingClientRect()
      setPos({ frac: Math.min(1, sc.scrollTop / max), top: r.top, height: r.height, right: r.right })
      setShow(true)
      later()
    }
    sc.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      sc.removeEventListener('scroll', onScroll)
      clearTimeout(hide.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const seek = (y: number) => {
    const sc = scroller.current
    if (!sc || !pos) return
    const frac = Math.max(0, Math.min(1, (y - pos.top - PAD - THUMB / 2) / (pos.height - 2 * PAD - THUMB)))
    sc.scrollTop = frac * (sc.scrollHeight - sc.clientHeight)
  }

  return (
    <>
      <span ref={anchor} hidden />
      {pos && (
        <div
          className={`fast-scroll ${show || drag ? 'on' : ''} ${drag ? 'drag' : ''}`}
          style={{ top: pos.top + PAD + pos.frac * (pos.height - 2 * PAD - THUMB), left: pos.right - 28, height: THUMB }}
          onPointerDown={(e) => {
            e.preventDefault()
            e.currentTarget.setPointerCapture(e.pointerId)
            dragging.current = true
            setDrag(true)
          }}
          onPointerMove={(e) => dragging.current && seek(e.clientY)}
          onPointerUp={() => {
            dragging.current = false
            setDrag(false)
            later()
          }}
          onPointerCancel={() => {
            dragging.current = false
            setDrag(false)
            later()
          }}
        >
          <span className="fs-bar" />
        </div>
      )}
    </>
  )
}
