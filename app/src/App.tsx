import { House, LibraryBig, Search, SlidersVertical, type LucideIcon } from 'lucide-react'
import { App as CapApp } from '@capacitor/app'
import { useEffect, useRef } from 'react'
import { MiniPlayer } from './components/MiniPlayer'
import { UpdateBanner } from './components/UpdateBanner'
import { popBack, useKeyboardOpen } from './components/ui'
import { isNative } from './lib/native'
import { t } from './lib/i18n'
import { usePinned } from './lib/pins'
import { useProfile } from './lib/profile'
import { Home, TOOLS } from './screens/Home'
import { ProfilePage } from './screens/Profile'
import { Add } from './screens/Add'
import { Library } from './screens/Library'
import { CatalogPage } from './screens/Catalog'
import { Player } from './screens/Player'
import { AlarmPage, AlarmRinging } from './screens/Alarm'
import { CapturePage } from './screens/Capture'
import { TunerPage } from './screens/Tuner'
import { useStore, type Tab } from './store'

// the bar: Home, Libreria, Cerca, then the tools pinned from Home
const TABS: Array<{ id: Tab; label: string; icon: LucideIcon }> = [
  { id: 'home', label: 'Home', icon: House },
  { id: 'library', label: 'Libreria', icon: LibraryBig },
  { id: 'add', label: 'Cerca', icon: Search }
]

export function App() {
  const store = useStore()
  const pinned = usePinned()
  const profile = useProfile()
  const tabs = [...TABS, ...TOOLS.filter((x) => pinned.includes(x.id))]
  const storeRef = useRef(store)
  storeRef.current = store
  const typing = useKeyboardOpen() // the tabs make room for the keyboard, like Spotify

  // Android back: close sheets / player / playlist first, never quit by accident
  useEffect(() => {
    if (!isNative) return
    const h = CapApp.addListener('backButton', () => {
      if (popBack()) return
      const s = storeRef.current
      if (s.tab !== 'home') s.setTab('home')
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
          {/* only on Home: the profile, a split running, the PC */}
          <header className="top" hidden={store.tab !== 'home' || store.pages.length > 0}>
            <button className="avatar" onClick={() => store.setTab('profile')} aria-label={t('Profilo')}>
              {(profile.name || '?').trim().charAt(0).toUpperCase()}
            </button>
            {store.deviceJob?.state === 'running' && (
              <button className="pill" onClick={() => store.setTab('add')}>
                <SlidersVertical /> {Math.round(store.deviceJob.pct)}%
                {store.deviceJob.queue?.length ? ` · +${store.deviceJob.queue.length} ${t('in coda')}` : ''}
              </button>
            )}
          </header>
          <UpdateBanner />
          <main className="content">
            {store.pages.length > 0 && <CatalogPage page={store.pages[store.pages.length - 1]} />}
            {/* tabs stay mounted under a page: the search results are still there when you come back */}
            <div hidden={store.pages.length > 0}>
              {store.tab === 'home' && <Home />}
              {store.tab === 'profile' && <ProfilePage />}
              {store.tab === 'library' && <Library />}
              {store.tab === 'add' && <Add />}
              {store.tab === 'tuner' && <TunerPage />}
              {store.tab === 'alarm' && <AlarmPage />}
              {store.tab === 'capture' && <CapturePage />}
            </div>
          </main>
          <MiniPlayer />
          <nav className="tabs" hidden={typing} style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }}>
            {tabs.map((tab) => (
              <button
                key={tab.id}
                className={store.tab === tab.id ? 'active' : ''}
                onClick={() => {
                  // tapping Libreria again goes back to the overview, like Spotify
                  if (tab.id === 'library' && store.tab === 'library') store.setLibView(null)
                  store.setTab(tab.id)
                }}
              >
                <tab.icon className="tab-icon" />
                {t(tab.label)}
              </button>
            ))}
          </nav>
        </>
      )}
      <AlarmRinging />
      {store.toast && <div className="toast">{store.toast}</div>}
    </div>
  )
}
