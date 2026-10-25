# OpenSpoty

**Suona insieme alla tua musica.** OpenSpoty è un'app per Android e Windows che riproduce le canzoni e le separa in tracce (voce, batteria, basso, chitarra, piano e altri strumenti), con controlli indipendenti per esercitarti. Include anche accordi e testi, regolazione di tono e velocità, loop A–B, accordatore, sveglie, riconoscimento dei brani e podcast.

> **Lingue:** l'interfaccia dell'app è disponibile in italiano e inglese. Al primo avvio segue la lingua del dispositivo (italiano sui dispositivi in italiano, inglese negli altri casi); puoi cambiarla in qualsiasi momento dal selettore nell'app. Schermate, pulsanti, messaggi e notifiche Android seguono la lingua scelta. Titoli, artisti, testi delle canzoni, trascrizioni e altri contenuti originali restano nella lingua della fonte. Le altre lingue del dispositivo usano l'inglese.

[Read this page in English](README.md)

## Download e installazione

Scarica l'APK Android o il pacchetto Windows più recente da [GitHub Releases](https://github.com/Jacoposchenetti/OpenSpoty/releases).

- **Android:** scarica l'APK e aprilo sul telefono. Se richiesto, consenti l'installazione da quella fonte. L'APK v1.12.0 attuale è una build di test firmata con la chiave di debug; gli aggiornamenti devono usare la stessa chiave. OpenSpoty è distribuita fuori da Google Play.
- **Windows:** scarica ed estrai `OpenSpoty-Windows.zip`, poi avvia `OpenSpoty.exe`. Al primo avvio Windows potrebbe chiedere conferma perché l'app non usa un certificato commerciale.

Per sincronizzare telefono e PC, apri la schermata di sincronizzazione su entrambi e inserisci l'indirizzo e il PIN mostrati dall'app PC. I due dispositivi devono essere sulla stessa rete locale.

## Funzioni

- **Tracce separate:** ascolta la registrazione originale oppure regola, silenzia e isola voce, batteria, basso, chitarra, piano e altri strumenti.
- **Esercitati:** cambia tono fino a ±6 semitoni e velocità dal 50% al 150%; rileva il BPM, imposta il count-in, crea loop A–B e visualizza accordi con testo sincronizzato.
- **Libreria musicale:** cerca e ascolta musica in streaming, importa playlist e album Spotify pubblici, crea playlist, salva preferiti e note e scarica i brani per l'ascolto offline.
- **Android e Windows:** usa OpenSpoty sul telefono e sul PC. Il Bridge locale può sincronizzare playlist, preferiti, note, mix ed eliminazioni tra i dispositivi sulla stessa rete.
- **Altri strumenti:** accordatore per chitarra, basso e ukulele; sveglie musicali; riconoscimento dei brani; podcast.

## Come funziona

OpenSpoty è sviluppata con React e Capacitor. La separazione audio usa [StemKit](https://github.com/danielravina/stemkit) e il modello HT-Demucs a sei tracce di Meta. Le tracce separate vengono salvate in FLAC senza perdita; il brano originale non viene ricompresso. Gli accordi vengono ricavati dall'audio sul dispositivo; tono e velocità usano Signalsmith Stretch.

Metadati e copertine del catalogo musicale provengono da Spotify; la riproduzione audio usa YouTube. I testi arrivano da LRCLIB. Queste integrazioni sono pensate per uso personale. Consulta nell'app i termini dei servizi applicabili.

## Feedback

Apri una [segnalazione](https://github.com/Jacoposchenetti/OpenSpoty/issues) indicando dispositivo e sistema operativo, lingua selezionata, passaggi per riprodurre il problema e risultato atteso. Evita di pubblicare file personali o contenuti protetti da copyright.

## Licenza

OpenSpoty è distribuita con licenza [GPL-3.0](LICENSE). Include componenti di terze parti con le rispettive licenze, tra cui StemKit, HT-Demucs, BTC chord recognition, SongRec, Signalsmith Stretch, ONNX Runtime e lucide. Per i dettagli, consulta il codice sorgente e i file di licenza inclusi.
