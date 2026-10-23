# Testi senza tempi: allineamento alla voce

Quando LRCLIB ha solo le parole di una canzone (senza i tempi delle righe), l'app ricava i tempi
dall'audio: Whisper tiny (OpenAI, licenza MIT) ascolta la traccia della voce (o la canzone, se non è
separata), le parole sentite vengono allineate a quelle del testo, e le righe senza parole riconosciute
vanno sugli attacchi della voce tra quelle riconosciute (`core/LyricsAligner.java`, `core/Whisper.java`).

## File

- `export_whisper.py`: crea i modelli ONNX (`out/`). Encoder: voce → K/V dell'attenzione incrociata.
  Decoder con la propria cache, il vocabolario in int8 (una scala per parola) usato sia in entrata sia
  in uscita. Poi `../fp16_weights.py` porta gli altri pesi a fp16 (`FP32_KEEP=vocab_scale,embed_positions`
  per il decoder): stessa qualità di fp32, 57 MB in tutto. L'int8 su tutto il modello perde molto.
- `whisper_ref.py`: la stessa decodifica di `Whisper.java`, in Python.
- `align.py`, `v2.py`: attacchi della voce e collocazione delle righe (come `LyricsAligner.java`).
- `eval_ref.py`: errore sull'inizio delle righe, su canzoni di cui LRCLIB ha i tempi veri.

## Risultati (5 canzoni, 165 righe)

| | entro 1 s | entro 2 s |
|---|---|---|
| solo il volume della voce | 16% | 20% |
| Whisper tiny + allineamento (fp32) | 56% | 76% |
| idem, modelli dell'app (fp16 + vocabolario int8) | 56% | 76% |
| idem, tolto lo spostamento costante tra versioni | 63% | 79% |
| Java (pc-engine), modelli dell'app | 56% | 76% |

Su "L'albero delle noci" (Brunori Sas): 75% entro 1 s, 98% entro 2 s. Una riga ancora fuori tempo si
sposta a mano: tienila premuta nella pagina Suona quando inizia.

## Pubblicare i modelli

I file vanno nella release `models-1` di GitHub (non è una versione dell'app):

```bash
gh release upload models-1 whisper_encoder.onnx whisper_decoder.onnx whisper_mel.bin whisper_vocab.json --clobber
```

dove `whisper_encoder.onnx` = `out/whisper_encoder.f16.onnx` e `whisper_decoder.onnx` = `out/whisper_decoder.f16.onnx`.
L'app li scarica la prima volta (`core/ModelStore.java`): sul telefono in `files/models`, sul PC in
`%APPDATA%\StemKitMobile\models` (OpenSpoty per Windows: `%APPDATA%\OpenSpoty\models`).
