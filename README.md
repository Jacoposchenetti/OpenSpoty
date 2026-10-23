# OpenSpoty

App per Android e PC per suonare dal vivo sopra le tue canzoni, separate in tracce (voce, batteria,
basso, chitarra, piano, altro). È basata su [StemKit](https://github.com/danielravina/stemkit)
(MIT) e sul modello HT-Demucs 6 tracce di Meta (MIT).

## Uso

| Cosa | Dove |
|---|---|
| App sul telefono | `OpenSpoty.apk` sul Desktop (già installata sul OnePlus 13) |
| App sul PC | icona **OpenSpoty** sul Desktop: la stessa app, in una finestra |
| Server del PC (Bridge) | parte da solo all'accensione, nascosto (Esecuzione automatica → "OpenSpoty Bridge") |
| OpenSpoty per Windows (da dare ad altri) | `OpenSpoty-Windows.zip` nella release di GitHub: si estrae e si apre `OpenSpoty.exe` |
| Collegare il telefono | icona di sincronizzazione in alto → indirizzo + PIN (sul PC li mostra la stessa icona) |

- **Stessa app, stessa versione**: il PC usa la stessa app del telefono, servita dal Bridge. `tools/deploy.sh` aggiorna entrambi insieme. Sul PC cerca, scarica e separa il PC stesso; sul telefono il telefono (YouTube e Spotify con lo stesso codice).
- **Sincronizzazione automatica** (all'avvio, al ritorno nell'app, dopo ogni modifica e ogni minuto, quando telefono e PC sono sulla stessa rete): playlist, Mi piace, note, mix ed eliminazioni vanno in entrambe le direzioni. Il PC riceve solo le canzoni **separate in tracce**; quelle solo da ascoltare restano sul telefono. Tutto ciò che c'è sul PC arriva anche sul telefono. Se il PC cambia indirizzo, il telefono lo ritrova da solo.
- **Importa da Spotify**: incolla in Cerca il link di una playlist o di un album pubblico; si possono importare più playlist insieme. I brani entrano in streaming (in pochi secondi); "Scarica anche" e "Separa anche" sono facoltativi.
- **Streaming come Spotify**: le canzoni si ascoltano da YouTube senza occupare spazio (cache automatica di 1 GB sul telefono, 2 GB sul PC, che si svuota da sola). Restano sul dispositivo solo se lo scegli: menu ⋮ → "Scarica sul dispositivo", oppure il tasto ↓ in cima a una playlist (di nuovo per "Rimuovi download"). Le canzoni separate in tracce restano sempre scaricate. Il cerchietto verde accanto a un brano indica che è scaricato.
- **Artisti e album** (dati Spotify, audio YouTube): nella ricerca compaiono artisti e album; tocca il titolo nel player o "Vai all'artista" nel menu ⋮. Pagina artista: brani popolari, discografia (album, singoli, raccolte), "Fan anche di", biografia. Pagina album: tutti i brani, "Salva" (come playlist) e "Scarica". Toccare un brano lo ascolta senza aggiungerlo; "+" lo mette in libreria.
- **Suona** (nel player): la pagina per suonare. In alto voce e strumenti (tocca il nome per silenziarlo, cursore per il volume, S = solo; "Tutte", "Senza voce"), poi Velocità e Tono (il tono sposta la musica e gli accordi; il tasto accanto apre BPM e count-in), accordi e testo, e in basso posizione, loop A-B e play. Il player principale mostra la copertina, come Spotify.
- **Accordi** (Suona → "Accordi"): riconosciuti dall'audio della canzone con una rete neurale (BTC, Park et al. 2019, licenza MIT: 170 tipi di accordo), non presi da internet. La prima volta servono circa 15 s sul telefono (9 s sul PC), poi restano salvati. Compaiono sopra le parole del testo sincronizzato, seguono la musica, cambiano con il Tono (che sposta anche la musica); il Capo cambia solo le posizioni da suonare; "Semplici" li riduce agli accordi base. Tocca un accordo per correggerlo: la correzione si sincronizza col PC. Senza testo sincronizzato compare la sequenza degli accordi. Verifica in `model-export/chords` (Let It Be, Knockin' on Heaven's Door, Stand by Me riconosciuti correttamente; il codice Java dà gli stessi accordi di Python nel 98–100% dei frame).
- **Accorda** (scheda): accordatore per chitarra (standard, Drop D, mezzo tono sotto, DADGAD, Open G), basso 4 e 5 corde, ukulele e cromatico. Rileva la nota dal microfono (metodo di McLeod, `src/lib/pitch.ts`: errore sotto 0,1 cent sui test), ago in cent, corda riconosciuta da sola o scelta a mano (con la nota di riferimento da ascoltare), La regolabile. Mette in pausa la musica mentre accordi.
- **Sveglia** (scheda): timer di spegnimento (rotelle ore : minuti : secondi) e sveglie con la tua musica (una canzone, una playlist, i brani che ti piacciono, un album o un artista), giorni della settimana oppure una data precisa scelta dal calendario, volume, salita graduale, posticipa. Suonano anche con l'app chiusa e dopo un riavvio (AlarmManager, `AlarmClock.java` / `AlarmService.java`); se la musica non parte (offline) suona la sveglia del telefono. I brani della libreria scelti per la sveglia vengono scaricati.
- **Cattura** (scheda): riconosce la canzone che sta suonando, come Shazam. L'impronta audio è calcolata sul dispositivo (port in Java di SongRec, GPLv3: `core/ShazamSignature.java`, verifica in `model-export/capture`) e inviata a Shazam; poi la puoi ascoltare, aggiungere o aprire l'artista. Sul PC usa il microfono del PC.
- **Una canzone in più playlist**: sì, "Aggiungi a playlist" dal menu ⋮ (la playlist contiene solo un riferimento: nessuna copia).

- **Libreria stile Spotify**: tocca un brano per farlo partire. La barra in basso (mini-player) apre il mixer delle tracce. Ci sono le playlist (crea, rinomina, elimina; riordini tenendo premuto la maniglia a puntini e trascinando) e il menu ⋮ per mettere in coda, aggiungere o spostare in un'altra playlist e aprire il mixer. "Ferma a fine brano" si attiva dalla finestra Coda.
- **Scarica / Separa**: ogni risultato della ricerca si può solo scaricare per ascoltarlo (originale, pochi secondi, nessuna ricompressione) oppure separare. Una canzone scaricata si separa anche dopo, dal menu ⋮ → "Separa le tracce", senza riscaricarla.
- **Originale o tracce, in automatico**: con tutte le tracce attive al 100% suona la registrazione originale (qualità piena); appena silenzi, isoli o cambi il volume di una traccia, il motore passa alle tracce nello stesso punto (dissolvenza di 46 ms, sfasamento tra originale e tracce misurato e corretto da solo).
- **Motore audio nativo** (`audio/Engine.java`): avvio in circa 0,1-0,4 s (istantaneo se il brano era già preparato), salti in circa 60 ms, loop A-B senza buchi, limitatore. Continua in background e a schermo spento, passa da solo al brano successivo, e risponde a notifica, schermata di blocco e tasti delle cuffie. Si mette in pausa per una chiamata o se scolleghi l'adattatore.
- **Qualità e volume, sempre al massimo**: tracce in FLAC senza perdita, originale mai ricompresso, limitatore oltre il 100%; ogni canzone è misurata una volta (EBU R128) e suonata a -14 LUFS, come Spotify.
- **Spotify**: tutti i brani della playlist, anche oltre 100. Per ogni brano trova su YouTube Music la stessa canzone (stesso artista e durata), la scarica e ricrea la playlist; volendo separa anche le tracce. YouTube tramite NewPipe Extractor (GPLv3), quindi l'app è GPL.
- **Tono e velocità** (Suona): ±6 semitoni e 50–150%, indipendenti tra loro, salvati per canzone. Calcolati dall'app con Signalsmith Stretch (MIT, `app/android/app/src/main/cpp`), che mantiene le formanti: alzando il tono la voce resta naturale (niente effetto "chipmunk"). A 100% e tono 0 l'audio non viene toccato.
- **Cerca e ordina** nelle liste: per titolo, artista o aggiunte di recente.
- **Nel player**: 🔀 Casuale, 🔁 Ripeti (tutto / brano), ♥ Mi piace (playlist automatica "Brani che ti piacciono"), 📝 Note per brano, 🎤 Testo (sincronizzato riga per riga da LRCLIB, salvato per l'uso offline), ⏲ Timer di spegnimento (minuti o fine brano).
- **Tono, velocità e tempo** (🎵): BPM rilevato da solo (correggibile con ×2 / ÷2 o battendo il tempo) e **count-in** di 1 o 2 battute prima che parta il brano che fai partire tu.
- **Libreria**: "Ascoltati di recente" in alto; copertine salvate sul dispositivo (anche offline).
- **Player**: tocca un riquadro per silenziare o riattivare la traccia; S = solo. Ci sono anche volumi, loop A-B e la scaletta con il tasto ⏭ per la canzone successiva. Lo schermo resta acceso.
- **Cube Street II**: adattatore USB-C → jack 3,5 mm (con DAC), poi cavo stereo nell'ingresso AUX IN.

## Cartelle

- `app/`: app (React + Capacitor). `app/android/`: progetto Android. Il codice nativo è in
  `app/android/app/src/main/java/app/stemkitmobile/` (separazione: `core/`, `SeparationService.java`).
- `bridge/stemkit_bridge.py` + `bridge/pc_app.py`: server del PC (app, libreria in `%APPDATA%\StemKitMobile`, sincronizzazione, separazione con il Python/Demucs/ffmpeg di StemKit desktop). Le canzoni già separate con StemKit desktop entrano da sole nella libreria.
- `pc-engine/`: il codice YouTube/Spotify del telefono (`YouTubeSource.java`) compilato per il PC.
- `tools/pc/OpenSpoty.vbs`: avvia il Bridge nascosto e apre l'app (`/background` = solo Bridge).
- `tools/pc/package.sh`: crea **OpenSpoty per Windows** (`dist-win/OpenSpoty-Windows.zip`, circa 190 MB) per chi non ha
  niente installato: Python 3.12 e una Java 21 ridotta (jlink) dentro il pacchetto, ffmpeg, il motore, l'app.
  `OpenSpoty.exe` (`tools/pc/Launcher.cs`) avvia il Bridge nascosto, apre l'app in una finestra di Edge tutta sua e
  chiude il Bridge quando la finestra si chiude. Libreria in `%APPDATA%\OpenSpoty`. Il separatore (PyTorch + Demucs,
  circa 1,5 GB, `tools/pc/separate.py`) si installa da solo la prima volta che si separa un brano (`bridge/portable.py`).
  Gli aggiornamenti: l'app trova `OpenSpoty-Windows.zip` nell'ultima release e mostra "Aggiornamento disponibile";
  il Bridge lo scarica, sostituisce la cartella e riapre l'app. A ogni release va allegato insieme all'APK.
- `model-export/`: conversione ONNX del modello e verifiche
  (core ONNX vs Demucs: SNR circa 80 dB; codice Java vs riferimento: SNR circa 136 dB).
- `tools/deploy.sh`: ricompila l'app per il PC e la reinstalla sul telefono collegato via USB.

## Ricompilare

```bash
bash ~/Desktop/stemkit-mobile/tools/deploy.sh
```

Serve il telefono collegato con il Debug USB attivo. Per OpenSpoty per Windows: `bash tools/pc/package.sh`. Android SDK: `C:\Users\jsche\Android\Sdk`.

## Licenza

GPL-3.0 (usa NewPipe Extractor, GPLv3). Componenti di terze parti: StemKit (MIT), HT-Demucs (MIT),
BTC chord recognition (MIT), SongRec (GPLv3, algoritmo dell'impronta Shazam), Signalsmith Stretch e Linear (MIT, in `app/android/app/src/main/cpp/third_party`),
ONNX Runtime (MIT), lucide (ISC). Testi da LRCLIB; catalogo e copertine da Spotify; audio da YouTube:
solo per uso personale.
