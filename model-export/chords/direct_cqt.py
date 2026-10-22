"""Single-rate CQT (the one ChordRecognizer.java computes) vs librosa's
multi-rate CQT that BTC was trained on: per-bin log offsets make them agree.

usage: python direct_cqt.py <song.wav>... -> prints differences, writes cqt_offsets.json
"""
import json
import sys

import numpy as np
import soundfile as sf

SR, HOP, BINS, BPO, FMIN = 22050, 2048, 144, 24, 32.70319566257483


def basis():
    freqs = FMIN * 2.0 ** (np.arange(BINS) / BPO)
    r = 2.0 ** (2.0 / BPO)
    alpha = (r - 1) / (r + 1)
    lengths = (1.0 / alpha) * SR / freqs
    n_fft = int(2 ** np.ceil(np.log2(lengths.max())))
    rows = []
    for f, L in zip(freqs, lengths):
        n = np.arange(np.floor(-L / 2), np.floor(L / 2))
        sig = np.hanning(len(n) + 2)[1:-1] if False else 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(len(n)) / len(n))
        k = sig * np.exp(1j * 2 * np.pi * f * n / SR)
        k /= np.abs(k).sum()
        pad = np.zeros(n_fft, complex)
        start = (n_fft - len(k)) // 2
        pad[start:start + len(k)] = k
        spec = np.fft.fft(pad)[: n_fft // 2 + 1] * (L / n_fft)
        # sparsify like librosa (drop the smallest 1% of each row's L1 mass)
        mag = np.abs(spec)
        order = np.argsort(mag)
        cut = np.searchsorted(np.cumsum(mag[order]) / mag.sum(), 0.01)
        spec[order[:cut]] = 0
        rows.append(spec)
    return np.array(rows), lengths, n_fft


B, LEN, NFFT = basis()


def cqt(y):
    """like BTC: 10-second pieces, each its own centred CQT (108 frames each)"""
    step = SR * 10
    parts, cur = [], 0
    while len(y) > cur + step:
        parts.append(cqt_piece(y[cur:cur + step]))
        cur += step
    parts.append(cqt_piece(y[cur:]))
    return np.concatenate(parts, axis=1)


def cqt_piece(y):
    pad = NFFT // 2
    yp = np.pad(y, (pad, pad))  # center, zeros (librosa 0.10 default)
    n_frames = 1 + len(y) // HOP
    out = np.zeros((BINS, n_frames))
    for m in range(n_frames):
        seg = yp[m * HOP:m * HOP + NFFT]
        if len(seg) < NFFT:
            seg = np.pad(seg, (0, NFFT - len(seg)))
        D = np.fft.rfft(seg)
        out[:, m] = np.abs(B @ D)
    return out / np.sqrt(LEN)[:, None]


if __name__ == "__main__":
    diffs = []
    for wav in sys.argv[1:]:
        y, sr = sf.read(wav, dtype="float32")
        assert sr == SR
        ref = np.load(wav + ".feat.npy").T  # bins x frames, log
        mine = np.log(cqt(y) + 1e-6)
        n = min(ref.shape[1], mine.shape[1])
        d = ref[:, :n] - mine[:, :n]
        # only frames with signal (log ~ -13.8 is silence)
        diffs.append(d[:, (ref[:, :n] > -10).all(0)])
        print(wav, "frames", ref.shape[1], mine.shape[1])
    d = np.concatenate(diffs, axis=1)
    off = np.median(d, axis=1)
    print("offset per octave:", [round(float(off[i * 24:(i + 1) * 24].mean()), 3) for i in range(6)])
    print("spread after offset (std per octave):", [round(float((d - off[:, None])[i * 24:(i + 1) * 24].std()), 3) for i in range(6)])
    json.dump([float(x) for x in off], open("cqt_offsets.json", "w"))
