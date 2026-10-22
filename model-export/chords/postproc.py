"""Chord decoding prototype (the Java ChordRecognizer does the same):
overlapping windows averaged, then Viterbi with a stay bonus (no flicker)."""
import json
import sys

import numpy as np
import onnxruntime as ort

HOP = 10.0 / 108
names = json.load(open(sys.argv[1] + ".labels.json"))
sess = ort.InferenceSession(sys.argv[1])


def probs(feat, step=54):
    n = feat.shape[0]
    pad = (-n) % 108 + 108
    f = np.pad(feat, ((0, pad), (0, 0)), constant_values=np.log(1e-6))
    acc = np.zeros((f.shape[0], 170))
    cnt = np.zeros((f.shape[0], 1))
    starts = list(range(0, f.shape[0] - 108 + 1, step))
    wins = np.stack([f[s:s + 108] for s in starts]).astype(np.float32)
    lo = sess.run(None, {"cqt": wins})[0]
    p = np.exp(lo - lo.max(-1, keepdims=True))
    p /= p.sum(-1, keepdims=True)
    # frames near a window's edge have less context: weight the middle more
    w = np.hanning(110)[1:-1][:, None] + 1e-3
    for s, pw in zip(starts, p):
        acc[s:s + 108] += pw * w
        cnt[s:s + 108] += w
    return (acc / cnt)[:n]


def viterbi(p, stay=0.0, switch=-6.0):
    lp = np.log(p + 1e-9)
    n, k = lp.shape
    score = lp[0].copy()
    back = np.zeros((n, k), dtype=np.int32)
    for t in range(1, n):
        best = score.argmax()
        stay_s = score + stay
        sw = score[best] + switch
        back[t] = np.where(stay_s >= sw, np.arange(k), best)
        score = np.maximum(stay_s, sw) + lp[t]
    path = np.zeros(n, dtype=np.int32)
    path[-1] = score.argmax()
    for t in range(n - 1, 0, -1):
        path[t - 1] = back[t, path[t]]
    return path


def segs(path):
    out = []
    for i, c in enumerate(path):
        if not out or out[-1][1] != c:
            out.append([round(i * HOP, 2), int(c)])
    return out


if __name__ == "__main__":
    for npy in sys.argv[2:]:
        feat = np.load(npy)
        ref = np.load(npy.replace(".feat.npy", ".pred.npy"))
        p = probs(feat)
        plain = p.argmax(-1)
        for sw in (-4.0, -8.0, -12.0):
            v = viterbi(p, switch=sw)
            s = segs(v)
            print(npy[:11], "switch", sw, "segmenti", len(s), "uguali al riferimento %.1f%%" % (100 * (v == ref).mean()))
        s = segs(viterbi(p, switch=-8.0))
        print("  ", " ".join(f"{t}:{names[c]}" for t, c in s[:40]))
        print("   riferimento:", len(segs(ref)), "segmenti; finestre sovrapposte senza viterbi:", len(segs(plain)))
