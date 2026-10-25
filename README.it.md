# OpenSpoty

**Streaming musicale gratuito, pensato per chi suona.** OpenSpoty permette di ascoltare musica in streaming gratuitamente e trasformare i brani in uno spazio per esercitarsi: carica accordi, segui il testo sincronizzato e controlla voce e singoli strumenti in modo indipendente. Disponibile per Android e Windows.

> **Come funziona lo streaming:** OpenSpoty non richiede un abbonamento. L'audio viene riprodotto tramite YouTube; Spotify fornisce metadati e copertine del catalogo, non l'audio. Disponibilità e pubblicità dipendono dai servizi sorgente. Usa le integrazioni nel rispetto dei relativi termini.

> **Lingue:** l'interfaccia dell'app è disponibile in italiano e inglese. Al primo avvio segue la lingua del dispositivo (italiano sui dispositivi in italiano, inglese negli altri casi); puoi cambiarla dal selettore nell'app. Titoli, artisti, testi, trascrizioni e nomi personalizzati restano nella lingua originale. Le altre lingue del dispositivo usano l'inglese.

[Read this page in English](README.md)

## Ascolta musica in streaming gratuitamente

Cerca musica, riproducila tramite YouTube e organizza la libreria con playlist e preferiti. Puoi anche importare playlist e album Spotify pubblici: Spotify fornisce metadati e copertine, mentre l'audio viene riprodotto tramite YouTube.

![Libreria musicale OpenSpoty con brani recenti, playlist e raccolta](screenshots/library-en.png)

*Libreria: brani ascoltati di recente, playlist e musica salvata.*

![Ricerca OpenSpoty con consigli di artisti e brani](screenshots/search-en.jpg)

*Ricerca e suggerimenti.*

## Esercitati con le parti che ti servono

OpenSpoty è pensata per musicisti e ascoltatori. In Play Along puoi regolare separatamente voce, batteria, basso, chitarra, piano e altri strumenti; silenziare o isolare le singole parti per concentrarti su ciò che stai studiando. Carica accordi e testo sincronizzato, modifica la posizione degli accordi e cambia tono o velocità. Rilevamento BPM, count-in e loop A–B aiutano a esercitarsi con precisione.

![Controlli Play Along di OpenSpoty per tracce strumentali, mute e solo, accordi e tonalità](screenshots/playalong-controls-en.jpg)

*Controlli Play Along. Questa schermata fornita è stata acquisita prima dell'ultimo aggiornamento delle traduzioni; la versione attuale traduce i controlli quando è selezionato l'inglese. Il ritaglio esclude il testo della canzone.*

![Player OpenSpoty con opzioni di riproduzione, copertina e coda](screenshots/player-en.jpg)

*Player: opzioni di riproduzione, copertina, controlli, volume e coda.*

![Seconda schermata del player OpenSpoty fornita dal proprietario del progetto](screenshots/player-en-duplicate.jpg)

*La seconda immagine del player è una copia della schermata fornita.*

## Altri strumenti musicali

- **Accordatore:** chitarra, basso e ukulele, con ascolto automatico o selezione manuale della corda.
- **Sveglie musicali e timer:** svegliati con un brano o imposta l'interruzione della riproduzione.
- **Riconoscimento dei brani:** identifica musica dall'audio circostante e consulta i risultati recenti.
- **Altre funzioni della libreria:** note, podcast, download offline e sincronizzazione tra telefono e PC sulla stessa rete locale.

![Accordatore per chitarra OpenSpoty con accordatura standard e feedback in tempo reale](screenshots/tuner-en.jpg)

*Accordatore per strumenti.*

![Timer di spegnimento e sveglie musicali OpenSpoty](screenshots/alarms-en.jpg)

*Timer e sveglie. I titoli delle sveglie e i brani scelti sono contenuti inseriti dall'utente e possono restare nella lingua originale.*

![Riconoscimento di un brano e identificazioni recenti in OpenSpoty](screenshots/identify-en.jpg)

*Riconoscimento musicale.*

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
