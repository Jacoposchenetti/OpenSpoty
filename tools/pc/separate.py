"""Splits a song into stems with Demucs (OpenSpoty for Windows).

Same command line as the bridge expects: --input mix.wav --out dir --model
htdemucs_6s --device cpu --shifts 1 --only vocals,drums,...; writes
<out>/<stem>.wav and prints JSON lines: {"type": "progress", "pct": n},
{"type": "error", "message": ...}.
"""
import argparse
import json
import sys
import wave

import numpy as np


def emit(**kw):
    print(json.dumps(kw), flush=True)


def load_wav(path):
    with wave.open(path, "rb") as w:
        sr, ch, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if width != 2:
        raise RuntimeError("serve un WAV a 16 bit")
    a = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    return a.reshape(-1, ch).T, sr


def save_wav(path, audio, sr):
    pcm = (np.clip(audio.T, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(pcm.shape[1])
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="htdemucs_6s")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--shifts", type=int, default=1)
    ap.add_argument("--only", default="")
    a = ap.parse_args()

    import torch
    import demucs.apply as dapply
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    # Demucs reports its progress through tqdm: turn it into JSON lines
    class Progress:
        def __init__(self, it, total=None, **_):
            self.it, self.total, self.done = it, total or len(it), 0

        def __iter__(self):
            for x in self.it:
                yield x
                self.done += 1
                emit(type="progress", pct=round(5 + 90 * self.done / max(1, self.total), 1))

    class Shim:
        tqdm = Progress

    dapply.tqdm = Shim

    emit(type="progress", pct=1)
    model = get_model(a.model)  # downloaded once into the torch cache
    model.eval()
    audio, sr = load_wav(a.input)
    if sr != model.samplerate:
        raise RuntimeError(f"serve audio a {model.samplerate} Hz")
    wav = torch.from_numpy(audio)
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    with torch.no_grad():
        out = apply_model(model, ((wav - mean) / std)[None], device=a.device, shifts=a.shifts, split=True, overlap=0.25, progress=True)[0]
    out = out * std + mean
    want = [s for s in a.only.split(",") if s] or list(model.sources)
    for name, stem in zip(model.sources, out):
        if name in want:
            save_wav(f"{a.out}/{name}.wav", stem.numpy(), sr)
    emit(type="progress", pct=100)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        emit(type="error", message=str(e)[:400] or e.__class__.__name__)
        sys.exit(1)
