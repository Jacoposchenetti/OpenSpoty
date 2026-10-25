# OpenSpoty

**Streaming musicale gratuito, pensato per chi suona.** OpenSpoty permette di ascoltare musica in streaming gratuitamente e trasformare i brani in uno spazio per esercitarsi: carica accordi, segui il testo sincronizzato e controlla voce e singoli strumenti in modo indipendente. Disponibile per Android e Windows.

> **Come funziona lo streaming:** OpenSpoty non richiede un abbonamento. L'audio viene riprodotto tramite YouTube; Spotify fornisce metadati e copertine del catalogo, non l'audio. Disponibilità e pubblicità dipendono dai servizi sorgente. Usa le integrazioni nel rispetto dei relativi termini.

> **Lingue:** l'interfaccia dell'app è disponibile in italiano e inglese. Al primo avvio segue la lingua del dispositivo (italiano sui dispositivi in italiano, inglese negli altri casi); puoi cambiarla dal selettore nell'app. Titoli, artisti, testi, trascrizioni e nomi personalizzati restano nella lingua originale. Le altre lingue del dispositivo usano l'inglese.

[Read this page in English](README.md)

## Ascolta musica in streaming gratuitamente

Cerca musica, riproducila tramite YouTube e organizza la libreria con playlist e preferiti. Puoi anche importare playlist e album Spotify pubblici: Spotify fornisce metadati e copertine, mentre l'audio viene riprodotto tramite YouTube.

<p align="center"><a href="screenshots/library-en.png"><img src="screenshots/library-en.png" width="120" alt="Libreria musicale OpenSpoty"></a> <a href="screenshots/search-en.jpg"><img src="screenshots/search-en.jpg" width="120" alt="Ricerca e suggerimenti OpenSpoty"></a></p>
<p align="center"><sub>Libreria</sub> <sub>Ricerca</sub></p>

## Esercitati con le parti che ti servono

OpenSpoty è pensata per musicisti e ascoltatori. In Play Along puoi regolare separatamente voce, batteria, basso, chitarra, piano e altri strumenti; silenziare o isolare le singole parti per concentrarti su ciò che stai studiando. Carica accordi e testo sincronizzato, modifica la posizione degli accordi e cambia tono o velocità. Rilevamento BPM, count-in e loop A–B aiutano a esercitarsi con precisione.

<p align="center"><a href="screenshots/playalong-controls-en.jpg"><img src="screenshots/playalong-controls-en.jpg" width="120" alt="Controlli Play Along per tracce, mute e solo, accordi e tonalità"></a> <a href="screenshots/player-en.jpg"><img src="screenshots/player-en.jpg" width="120" alt="Player e controlli della coda"></a></p>
<p align="center"><sub>Play Along</sub> <sub>Player</sub></p>

*Play Along con controlli in inglese e testo sincronizzato.*

## Altri strumenti musicali

- **Accordatore:** chitarra, basso e ukulele, con ascolto automatico o selezione manuale della corda.
- **Sveglie musicali e timer:** svegliati con un brano o imposta l'interruzione della riproduzione.
- **Riconoscimento dei brani:** identifica musica dall'audio circostante e consulta i risultati recenti.
- **Altre funzioni della libreria:** note, podcast, download offline e sincronizzazione tra telefono e PC sulla stessa rete locale.

<p align="center"><a href="screenshots/tuner-en.jpg"><img src="screenshots/tuner-en.jpg" width="120" alt="Accordatore per chitarra con feedback in tempo reale"></a> <a href="screenshots/alarms-en.jpg"><img src="screenshots/alarms-en.jpg" width="120" alt="Timer e sveglie musicali"></a> <a href="screenshots/identify-en.jpg"><img src="screenshots/identify-en.jpg" width="120" alt="Riconoscimento e risultati recenti"></a></p>
<p align="center"><sub>Accordatore</sub> <sub>Sveglie e timer</sub> <sub>Riconoscimento</sub></p>

*I titoli delle sveglie e i brani scelti sono contenuti inseriti dall'utente e possono restare nella lingua originale.*

## Download e installazione

Scarica l'APK Android o il pacchetto Windows da [GitHub Releases](https://github.com/Jacoposchenetti/OpenSpoty/releases).

- **Android:** scarica l'APK e aprilo sul telefono. Se richiesto, consenti l'installazione da quella fonte. L'APK v1.12.0 attuale è una build di test firmata con la chiave di debug; gli aggiornamenti devono usare la stessa chiave. OpenSpoty è distribuita fuori da Google Play.
- **Windows:** scarica ed estrai `OpenSpoty-Windows.zip`, poi avvia `OpenSpoty.exe`. Al primo avvio Windows potrebbe chiedere conferma perché l'app non usa un certificato commerciale.

Per sincronizzare telefono e PC, apri la schermata di sincronizzazione su entrambi e inserisci l'indirizzo e il PIN mostrati dall'app PC. I due dispositivi devono essere sulla stessa rete locale.

## Come funziona

OpenSpoty è sviluppata con React e Capacitor. La separazione audio usa [StemKit](https://github.com/danielravina/stemkit) e il modello HT-Demucs a sei tracce di Meta. Le tracce separate vengono salvate in FLAC senza perdita; il brano originale non viene ricompresso. Gli accordi vengono ricavati dall'audio sul dispositivo; tono e velocità usano Signalsmith Stretch. I testi arrivano da LRCLIB.

## Feedback

Prova l'app e raccontaci cosa funziona e cosa no. Per segnalare un problema, indica dispositivo e sistema operativo, lingua selezionata, passaggi per riprodurlo e risultato atteso in una [segnalazione](https://github.com/Jacoposchenetti/OpenSpoty/issues). Sono particolarmente utili i feedback sulle traduzioni e sulle funzioni per musicisti. Evita di pubblicare file personali o contenuti protetti da copyright.

## Licenza

OpenSpoty è distribuita con licenza [GPL-3.0](LICENSE). Include componenti di terze parti con le rispettive licenze, tra cui StemKit, HT-Demucs, BTC chord recognition, SongRec, Signalsmith Stretch, ONNX Runtime e lucide. Per i dettagli, consulta il codice sorgente e i file di licenza inclusi.
