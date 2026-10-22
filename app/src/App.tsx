import { AlarmClock, AudioLines, Guitar, LibraryBig, Search, SlidersVertical, type LucideIcon } from 'lucide-react'
import { App as CapApp } from '@capacitor/app'
import { useEffect, useRef, useState } from 'react'
import { MiniPlayer } from './components/MiniPlayer'
import { SyncButton, SyncSheet } from './components/SyncSheet'
import { UpdateBanner } from './components/UpdateBanner'
import { popBack } from './components/ui'
import { isNative } from './lib/native'
import { Add } from './screens/Add'
import { Library } from './screens/Library'
import { CatalogPage } from './screens/Catalog'
import { Player } from './screens/Player'
import { AlarmPage, AlarmRinging } from './screens/Alarm'
import { CapturePage } from './screens/Capture'
import { TunerPage } from './screens/Tuner'
import { useStore, type Tab } from './store'

const TABS: Array<{ id: Tab; label: string; icon: LucideIcon }> = [
  { id: 'library', label: 'Libreria', icon: LibraryBig },
  { id: 'add', label: 'Cerca', icon: Search },
  { id: 'tuner', label: 'Accorda', icon: Guitar },
  { id: 'alarm', label: 'Sveglia', icon: AlarmClock },
  { id: 'capture', label: 'Cattura', icon: AudioLines }
]

export function App() {
  const store = useStore()
  const storeRef = useRef(store)
  storeRef.current = store
  const [syncOpen, setSyncOpen] = useState(false)

  // Android back: close sheets / player / playlist first, never quit by accident
  useEffect(() => {
    if (!isNative) return
    const h = CapApp.addListener('backButton', () => {
      if (popBack()) return
      const s = storeRef.current
      if (s.tab !== 'library') s.setTab('library')
      else void CapApp.minimizeApp()
    })
    return () => {
      void h.then((x) => x.remove())
    }
  }, [])

  if (!store.ready) return <div className="splash">OpenSpoty</div>

  return (
    <div className="app">
      {store.playerOpen ? (
        <Player />
      ) : (
        <>
          <header className="top">
            <span className="logo">
              <b>OpenSpoty</b>
            </span>
            {store.deviceJob?.state === 'running' && (
              <button className="pill" onClick={() => store.setTab('add')}>
                <SlidersVertical /> {Math.round(store.deviceJob.pct)}%
                {store.deviceJob.queue?.length ? ` · +${store.deviceJob.queue.length} in coda` : ''}
              </button>
            )}
            <SyncButton onClick={() => setSyncOpen(true)} />
          </header>
          <UpdateBanner />
          <main className="content">
            {store.pages.length > 0 && <CatalogPage page={store.pages[store.pages.length - 1]} />}
            {/* tabs stay mounted under a page: the search results are still there when you come back */}
            <div hidden={store.pages.length > 0}>
              {store.tab === 'library' && <Library />}
              {store.tab === 'add' && <Add />}
              {store.tab === 'tuner' && <TunerPage />}
              {store.tab === 'alarm' && <AlarmPage />}
              {store.tab === 'capture' && <CapturePage />}
            </div>
          </main>
          <MiniPlayer />
          <nav className="tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={store.tab === t.id ? 'active' : ''}
                onClick={() => {
                  // tapping Libreria again goes back to the overview, like Spotify
                  if (t.id === 'library' && store.tab === 'library') store.setLibView(null)
                  store.setTab(t.id)
                }}
              >
                <t.icon className="tab-icon" />
                {t.label}
              </button>
            ))}
          </nav>
        </>
      )}
      {syncOpen && <SyncSheet onClose={() => setSyncOpen(false)} />}
      <AlarmRinging />
      {store.toast && <div className="toast">{store.toast}</div>}
    </div>
  )
}
