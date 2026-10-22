import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'app.stemkitmobile',
  appName: 'OpenSpoty',
  webDir: 'dist',
  android: {
    // the PC bridge speaks plain http on the home network
    allowMixedContent: true
  },
  plugins: {
    StatusBar: { backgroundColor: '#0b0b10', style: 'DARK', overlaysWebView: false }
  }
}

export default config
