import { ArrowLeft, Copy, Share2 } from 'lucide-react'
import qrcode from 'qrcode-generator'
import { useMemo, useState } from 'react'
import { Share } from '@capacitor/share'
import { t, useLocale } from '../lib/i18n'
import { setProfile, useProfile } from '../lib/profile'
import { useStore } from '../store'
import { SyncButton, SyncSheet } from '../components/SyncSheet'

/* Profilo: name (also used in Jams), where you are, language, and a QR code
   friends scan to download the app. */

const DOWNLOAD = 'https://github.com/Jacoposchenetti/OpenSpoty/releases/latest'

export function ProfilePage() {
  const store = useStore()
  const profile = useProfile()
  const { language, setLanguage } = useLocale()
  const [name, setName] = useState(profile.name)
  const [place, setPlace] = useState(profile.location)
  const [syncOpen, setSyncOpen] = useState(false)
  const svg = useMemo(() => {
    const q = qrcode(0, 'M')
    q.addData(DOWNLOAD)
    q.make()
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
  }, [])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(DOWNLOAD)
      store.showToast(t('Link copiato'))
    } catch {
      void Share.share({ url: DOWNLOAD })
    }
  }
  return (
    <div className="profile">
      <div className="profile-head">
        <button className="icon-btn" onClick={() => store.setTab('home')} aria-label={t('Indietro')}>
          <ArrowLeft />
        </button>
        <h1>{t('Profilo')}</h1>
      </div>
      <div className="profile-avatar">{(profile.name || '?').trim().charAt(0).toUpperCase()}</div>

      <label className="field">
        <span>{t('Nome')}</span>
        <input value={name} maxLength={30} placeholder={t('Come ti chiami?')} onChange={(e) => (setName(e.target.value), setProfile({ name: e.target.value.trim() }))} />
        <small className="muted">{t('Lo vedono gli amici nelle Jam: non ti verrà più chiesto.')}</small>
      </label>
      <label className="field">
        <span>{t('Dove sei')}</span>
        <input value={place} maxLength={60} placeholder={t('Città')} onChange={(e) => (setPlace(e.target.value), setProfile({ location: e.target.value.trim() }))} />
      </label>
      <div className="field">
        <span>{t('PC')}</span>
        <span className="profile-sync">
          <SyncButton onClick={() => setSyncOpen(true)} />
          <small className="muted">{t('Libreria e playlist in sincronia con OpenSpoty sul computer.')}</small>
        </span>
      </div>
      {syncOpen && <SyncSheet onClose={() => setSyncOpen(false)} />}
      <label className="field">
        <span>{t('Lingua')}</span>
        <select value={language} onChange={(e) => setLanguage(e.target.value === 'it' ? 'it' : 'en')}>
          <option value="it">{t('Italiano')}</option>
          <option value="en">{t('English')}</option>
        </select>
      </label>

      <div className="q-head">{t('Fai scaricare OpenSpoty')}</div>
      <p className="muted small">{t('Chi inquadra il codice apre la pagina per scaricare l’app (Android e PC).')}</p>
      <div className="jam-qr" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="jam-actions">
        <button onClick={() => void copy()}>
          <Copy /> {t('Copia link')}
        </button>
        <button onClick={() => void Share.share({ title: 'OpenSpoty', text: t('Scarica OpenSpoty'), url: DOWNLOAD })}>
          <Share2 /> {t('Condividi')}
        </button>
      </div>
    </div>
  )
}
