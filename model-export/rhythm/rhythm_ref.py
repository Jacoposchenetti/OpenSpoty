"""Reference for core/Rhythm.java: audio (22.05 kHz mono) -> beats, bars and their meter.

1. log-mel spectrogram as Beat This! computes it (torchaudio MelSpectrogram, n_fft 1024, hop 441,
   slaney mel 30–11000 Hz, magnitude normalized by the window, log1p(1000 x)): 50 frames/s
2. the ONNX model on chunks of 1500 frames overlapping by 6 at each side (keep the first)
3. beats: local maxima within ±3 frames with logit > 0, neighbours merged
4. meter: Viterbi over the beats, states (beats per bar, position); a change only at a bar
   start and it costs CHANGE (see meter.py: 4/4 and 3/4 reliable, odd meters only in part)
"""
import os

import numpy as np
import onnxruntime as ort

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
SR, NFFT, HOP, FPS, CHUNK, BORDER = 22050, 1024, 441, 50, 1500, 6
METERS = [2, 3, 4, 5, 6, 7]
PRIOR = {2: 0.02, 3: 0.2, 4: 0.5, 5: 0.06, 6: 0.06, 7: 0.06}
CHANGE = 14.0


def log_mel(y):
    fb = np.fromfile(f"{OUT}/beat_mel.bin", dtype="<f4").reshape(513, 128)
    win = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(NFFT) / NFFT)
    norm = np.sqrt((win ** 2).sum())
    x = np.pad(y, (NFFT // 2, NFFT // 2), mode="reflect")
    n = 1 + (len(x) - NFFT) // HOP
    out = np.empty((n, 128), np.float32)
    for s in range(0, n, 2000):
        idx = np.arange(s, min(n, s + 2000))
        frames = np.stack([x[i * HOP: i * HOP + NFFT] for i in idx]) * win
        mag = np.abs(np.fft.rfft(frames, axis=1)) / norm
        out[idx] = np.log1p(1000 * (mag @ fb))
    return out


def predict(spect, model=f"{OUT}/beat_this.onnx"):
    s = ort.InferenceSession(model)
    T = len(spect)
    starts = list(range(-BORDER, T - BORDER, CHUNK - 2 * BORDER))
    if T > CHUNK - 2 * BORDER:
        starts[-1] = T - (CHUNK - BORDER)
    beat = np.full(T, -1000.0, np.float32)
    down = np.full(T, -1000.0, np.float32)
    for st in reversed(starts):  # earlier chunks win (keep_first)
        a, b = max(st, 0), min(st + CHUNK, T)
        chunk = np.zeros((CHUNK if T >= CHUNK else b - a + max(0, -st) + max(0, min(BORDER, st + CHUNK - T)), 128), np.float32)
        chunk[max(0, -st): max(0, -st) + (b - a)] = spect[a:b]
        pb, pd = s.run(None, {"spect": chunk[None]})
        lo, hi = st + BORDER, min(st + CHUNK - BORDER, T)
        seg = slice(BORDER, BORDER + (hi - lo))
        beat[lo:hi] = pb[0][seg][: hi - lo]
        down[lo:hi] = pd[0][seg][: hi - lo]
    return beat, down


def peaks(logits):
    T = len(logits)
    keep = []
    for i in range(T):
        if logits[i] <= 0:
            continue
        if logits[i] >= logits[max(0, i - 3): i + 4].max():
            keep.append(i)
    # neighbours (one frame apart) become one, at their mean
    out, group = [], []
    for i in keep:
        if group and i - group[-1] > 1:
            out.append(np.mean(group))
            group = []
        group.append(i)
    if group:
        out.append(np.mean(group))
    return np.array(out) / FPS


def meters(pdown):
    states = [(m, k) for m in METERS for k in range(m)]
    idx = {s: i for i, s in enumerate(states)}
    eps = 1e-4
    lp, lq = np.log(np.clip(pdown, eps, 1 - eps)), np.log(np.clip(1 - pdown, eps, 1 - eps))
    n, S = len(pdown), len(states)
    score = np.array([np.log(PRIOR[m]) - (0 if k == 0 else 1.0) + (lp[0] if k == 0 else lq[0]) for m, k in states])
    back = np.zeros((n, S), np.int32)
    for i in range(1, n):
        new = np.empty(S)
        for j, (m, k) in enumerate(states):
            if k > 0:
                p = idx[(m, k - 1)]
                new[j] = score[p]
                back[i, j] = p
            else:
                best, arg = -1e18, 0
                for m2 in METERS:
                    p = idx[(m2, m2 - 1)]
                    v = score[p] - (0 if m2 == m else CHANGE) + 0.1 * np.log(PRIOR[m])
                    if v > best:
                        best, arg = v, p
                new[j] = best
                back[i, j] = arg
            new[j] += lp[i] if k == 0 else lq[i]
        score = new
    j = int(np.argmax(score))
    path = [j]
    for i in range(n - 1, 0, -1):
        j = int(back[i, j])
        path.append(j)
    return [states[j] for j in path[::-1]]


def analyse(y, model=f"{OUT}/beat_this.onnx"):
    spect = log_mel(y)
    beat, down = predict(spect, model)
    beats = peaks(beat)
    dprob = 1 / (1 + np.exp(-down))
    pdown = np.array([dprob[max(0, int(round(b * FPS)) - 2): int(round(b * FPS)) + 3].max() for b in beats])
    return beats, meters(pdown) if len(beats) else []
