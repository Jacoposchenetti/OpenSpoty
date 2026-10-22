import { CircleArrowUp, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { errMsg } from '../lib/format'
import { StemKitNative } from '../lib/native'
import { checkUpdate, type Update } from '../lib/update'
import { Spinner } from './ui'

/** a bar at the top when GitHub has a newer OpenSpoty: one tap downloads and installs it */
export function UpdateBanner() {
  const [up, setUp] = useState<Update | null>(null)
  const [pct, setPct] = useState<number | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [hidden, setHidden] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => void checkUpdate().then(setUp).catch(() => undefined), 3000)
    return () => clearTimeout(t)
  }, [])
  if (!up || hidden) return null
  const install = async () => {
    setMsg(null)
    setPct(0)
    const h = StemKitNative.addListener('transfer', (e) => e.id === 'update' && setPct(e.pct))
    try {
      const r = await StemKitNative.installUpdate({ url: up.url })
      if (r.needsPermission) setMsg('Consenti "Installa app sconosciute" a OpenSpoty, poi torna qui e tocca di nuovo Aggiorna.')
    } catch (e) {
      setMsg(errMsg(e))
    } finally {
      void h.then((x) => x.remove())
      setPct(null)
    }
  }
  return (
    <div className="update-banner">
      <CircleArrowUp />
      <span className="update-text">
        <b>Aggiornamento disponibile</b>
        <span className="muted small">
          OpenSpoty {up.version}
          {msg ? ` · ${msg}` : ''}
        </span>
      </span>
      <button className="primary small" disabled={pct !== null} onClick={() => void install()}>
        {pct !== null ? (
          <>
            <Spinner size={14} /> {pct}%
          </>
        ) : (
          'Aggiorna'
        )}
      </button>
      <button className="icon-btn" onClick={() => setHidden(true)} aria-label="Più tardi">
        <X />
      </button>
    </div>
  )
}
