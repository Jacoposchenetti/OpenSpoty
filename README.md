# OpenSpoty

**Play along with your music.** OpenSpoty is an Android and Windows app for listening to music, separating songs into vocals, drums, bass, guitar, piano, and other stems, and practicing with independent controls. It also includes chords and lyrics, pitch and speed controls, A–B looping, a tuner, alarms, song identification, and podcasts.

> **Languages:** The app interface is available in Italian and English. It follows the device language on first launch (Italian for Italian devices, English otherwise), and you can change it at any time from the in-app language selector. Interface labels, screens, app messages, and Android notifications follow the selected language. Song titles, artist names, lyrics, transcripts, and other source material stay in their original language. Other device languages currently use English.

[Leggi in italiano](README.it.md)

## Screenshots

| Search and recommendations | Identify a song |
| --- | --- |
| ![OpenSpoty search and music recommendations in English](screenshots/search-en.jpg) | ![OpenSpoty song identification screen in English](screenshots/identify-en.jpg) |

## Download and install

Download the latest Android APK or Windows package from [GitHub Releases](https://github.com/Jacoposchenetti/OpenSpoty/releases).

- **Android:** download the APK, open it on your phone, and approve installation from that source if Android asks. The current v1.12.0 APK is a debug-signed tester build; updates need the same signing key. OpenSpoty is distributed outside Google Play.
- **Windows:** download and extract `OpenSpoty-Windows.zip`, then run `OpenSpoty.exe`. Windows may ask you to confirm the first launch because the app is not signed with a commercial certificate.

For phone–PC sync, open the sync screen on both devices and enter the address and PIN shown by the PC app. Keep both devices on the same local network.

## Features

- **Stem playback:** listen to the original recording or mute, solo, and adjust individual stems.
- **Practice tools:** change pitch by up to ±6 semitones and speed from 50% to 150%; detect BPM, set a count-in, loop an A–B section, and view chords with synchronized lyrics.
- **Music library:** search and stream music, import public Spotify playlists and albums, create playlists, save favorites and notes, and download songs for offline playback.
- **Android and Windows:** use OpenSpoty on your phone and PC. A local Bridge can synchronize playlists, favorites, notes, mixes, and deletions between devices on the same network.
- **More tools:** guitar, bass, and ukulele tuner; music alarms; song identification; and podcast playback.

## How it works

OpenSpoty is built with React and Capacitor. Audio separation uses [StemKit](https://github.com/danielravina/stemkit) and Meta's six-stem HT-Demucs model. Separated stems are stored as lossless FLAC; the original track is not recompressed. Chords are inferred on the device, and pitch and speed changes use Signalsmith Stretch.

Music catalog metadata and artwork come from Spotify; audio playback uses YouTube. Lyrics are provided by LRCLIB. These integrations are intended for personal use. See the app for applicable service terms.

## Repository layout

- `app/` — React + Capacitor application and Android project.
- `bridge/` — Windows PC Bridge and synchronization service.
- `pc-engine/` — Windows version of the phone's YouTube/Spotify engine.
- `tools/` — deployment and Windows packaging scripts.
- `model-export/` — model conversion and validation materials.

## Build from source

For Windows packaging, run `bash tools/pc/package.sh` from Git Bash with the required build tools installed. For Android development, open `app/` in Android Studio and use the Capacitor/Android toolchain. See the scripts under `tools/` for deployment details.

## Feedback

Open an [issue](https://github.com/Jacoposchenetti/OpenSpoty/issues) with the device/OS, selected app language, steps to reproduce, and what you expected to happen. Please avoid posting private or copyrighted media.

## License

OpenSpoty is licensed under [GPL-3.0](LICENSE). It includes third-party components under their respective licenses, including StemKit, HT-Demucs, BTC chord recognition, SongRec, Signalsmith Stretch, ONNX Runtime, and lucide. See the source tree and bundled license files for details.
