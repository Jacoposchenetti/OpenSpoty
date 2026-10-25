import { Check, CloudOff, RefreshCw, Smartphone, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Bridge } from '../lib/bridge'
import { errMsg } from '../lib/format'
import { isDesktop } from '../lib/native'
import { localeTag, t } from '../lib/i18n'
import { useStore, type SyncStatus } from '../store'
import { Sheet } from './ui'

const clock = (time?: number) => (time ? new Date(time).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' }) : '')

/** small status icon in the header; opens the sync sheet */
export function SyncButton({ onClick }: { onClick: () => void }) {
  const { sync, bridgeCfg } = useStore()
  if (!isDesktop && !bridgeCfg) {
    return (
      <button className="pill" onClick={onClick}>
        {t('Collega il PC')}
      </button>
    )
  }
  return (
    <button className={`sync-btn ${sync.state}`} onClick={onClick} aria-label={t('Sincronizzazione')}>
      {icon(sync)}
      {sync.state === 'syncing' && sync.total ? (
        <small>
          {sync.done}/{sync.total}
        </small>
      ) : null}
    </button>
  )
}

function icon(s: SyncStatus) {
  if (s.state === 'syncing') return <RefreshCw className="spin" />
  if (s.state === 'offline') return <CloudOff />
  if (s.state === 'error') return <TriangleAlert />
  if (s.state === 'off') return isDesktop ? <Smartphone /> : <RefreshCw />
  return <Check />
}

export function SyncSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title={t('Telefono e PC')} onClose={onClose}>
      {isDesktop ? <PcSide /> : <PhoneSide />}
    </Sheet>
  )
}

/* on the PC: what to type on the phone, and when it last synced */
function PcSide() {
  const { sync } = useStore()
  const [info, setInfo] = useState<{ addresses: string[]; pin: string; name: string } | null>(null)
  useEffect(() => {
    void fetch('/api/pc/pairing')
      .then((r) => r.json())
      .then(setInfo)
      .catch(() => undefined)
  }, [])
  return (
    <>
      <p>{sync.at ? t('Ultima sincronizzazione col telefono alle {time}.', { time: clock(sync.at) }) : t('Il telefono non si è ancora sincronizzato.')}</p>
      {info && (
        <div className="pairing">
          <span className="muted small">{t('Per collegare il telefono')}</span>
          <div>
            {t('Indirizzo')} <b>{info.addresses[0]}</b>
          </div>
          <div>
            PIN <b className="pin">{info.pin}</b>
          </div>
        </div>
      )}
    </>
  )
}

function PhoneSide() {
  const store = useStore()
  const { sync } = store
  const [editing, setEditing] = useState(!store.bridgeCfg)
  const [address, setAddress] = useState(store.bridgeCfg?.address ?? '')
  const [pin, setPin] = useState(store.bridgeCfg?.pin ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connect = async () => {
    setBusy(true)
    setError(null)
    try {
      const cfg = { address: address.trim(), pin: pin.trim() }
      await new Bridge(cfg).auth()
      await store.setBridgeCfg(cfg)
      setEditing(false)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <>
        <p className="muted small">{t('Sul PC apri OpenSpoty: in alto a destra trovi indirizzo e PIN.')}</p>
        <label>
          {t('Indirizzo')}
          <input inputMode="url" placeholder="192.168.1.36:8777" value={address} onChange={(e) => setAddress(e.target.value)} autoCapitalize="off" autoCorrect="off" />
        </label>
        <label>
          PIN
          <input inputMode="numeric" placeholder={t('6 cifre')} maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        </label>
        <button className="primary" disabled={busy || !address || pin.length !== 6} onClick={() => void connect()}>
          {busy ? t('Collegamento…') : t('Collega')}
        </button>
        {error && <div className="notice error">{error}</div>}
      </>
    )
  }

  return (
    <>
      <p>
        {sync.state === 'syncing'
          ? sync.total
            ? t('Copio i brani: {done}/{total} file', { done: sync.done ?? 0, total: sync.total ?? 0 })
            : t('Sincronizzo…')
          : sync.state === 'ok'
            ? t('Sincronizzato{pc} alle {time}', { pc: sync.pcName ? ` with ${sync.pcName}` : '', time: clock(sync.at) })
            : sync.state === 'offline'
              ? t('PC non raggiungibile: è acceso e sullo stesso Wi-Fi?')
              : sync.state === 'error'
                ? sync.error
                : t('In attesa…')}
      </p>
      <button className="primary" disabled={sync.state === 'syncing'} onClick={store.syncNow}>
        <RefreshCw /> {t('Sincronizza ora')}
      </button>
      <button onClick={() => setEditing(true)}>{t('Cambia PC')}</button>
    </>
  )
}
