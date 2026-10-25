import { StatusBar, Style } from '@capacitor/status-bar'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ImportsProvider } from './imports'
import { isNative } from './lib/native'
import { LocaleProvider } from './lib/i18n'
import { PlaybackProvider } from './playback'
import { StoreProvider } from './store'
import './styles.css'

if (isNative) {
  // light icons on the dark background
  void StatusBar.setStyle({ style: Style.Dark }).catch(() => undefined)
  void StatusBar.setBackgroundColor({ color: '#0b0b10' }).catch(() => undefined)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LocaleProvider>
      <StoreProvider>
        <PlaybackProvider>
          <ImportsProvider>
            <App />
          </ImportsProvider>
        </PlaybackProvider>
      </StoreProvider>
    </LocaleProvider>
  </StrictMode>
)
