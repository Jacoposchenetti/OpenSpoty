"""v2: ASR anchors (monotonic) + voice onsets for the rest. Reads cached ASR words."""
import json, os, re, sys, unicodedata
import numpy as np
from align import envelope, onsets, parse_lrc, HOP, syllables

LEVEL = sys.argv[1]
SIDS = sys.argv[2:]
P = dict(lo=float(os.environ.get("LO", 1.2)), hi=float(os.environ.get("HI", 0.4)), bias=float(os.environ.get("BIAS", 0.0)))


def norm_words(s):
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return [w for w in re.split(r"[^a-z0-9]+", s) if w]


def lev(a, b):
    if a == b:
        return 1.0
    la, lb = len(a), len(b)
    d = list(range(lb + 1))
    for i in range(1, la + 1):
        p, d[0] = d[0], i
        for j in range(1, lb + 1):
            p, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, p + (a[i - 1] != b[j - 1]))
    return 1 - d[lb] / max(la, lb)


def match_words(lines, asr):
    L = [(w, li) for li, line in enumerate(lines) for w in norm_words(line)]
    n, m = len(L), len(asr)
    S = np.zeros((n + 1, m + 1))
    S[1:, 0] = -0.4 * np.arange(1, n + 1)
    S[0, 1:] = -0.3 * np.arange(1, m + 1)
    B = np.zeros((n + 1, m + 1), dtype=np.int8)
    sims = {}
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            sim = lev(L[i - 1][0], asr[j - 1][0])
            sims[i, j] = sim
            diag = S[i - 1, j - 1] + (2 * sim if sim >= 0.6 else -0.6)
            up, left = S[i - 1, j] - 0.4, S[i, j - 1] - 0.3
            best = max(diag, up, left)
            S[i, j] = best
            B[i, j] = 0 if best == diag else (1 if best == up else 2)
    i, j, match = n, m, {}
    while i > 0 and j > 0:
        if B[i, j] == 0:
            if sims[i, j] >= 0.6:
                match[i - 1] = asr[j - 1][1]
            i, j = i - 1, j - 1
        elif B[i, j] == 1:
            i -= 1
        else:
            j -= 1
    return L, match


def place(lines, asr, act, runs, dur):
    on = np.array([r[0] * HOP for r in runs])
    cum = np.concatenate([[0], np.cumsum(act)]) * HOP
    voiced = lambda t: cum[min(len(cum) - 1, max(0, int(t / HOP)))]
    # ASR words where the voice is silent are hallucinations
    def sung(t):
        a, b = max(0, int((t - 0.4) / HOP)), int((t + 0.6) / HOP)
        return act[a:b].any()
    asr = [(w, t) for w, t in asr if sung(t)]
    L, match = match_words(lines, asr)
    N = len(lines)
    anchor = [None] * N
    for li in range(N):
        idx = [k for k, (w, l) in enumerate(L) if l == li]
        got = [(p, match[k]) for p, k in enumerate(idx) if k in match]
        if not got:
            continue
        p, t = got[0]
        a = t - 0.3 * p - P["bias"]
        c = on[(on >= a - P["lo"]) & (on <= a + P["hi"])]
        anchor[li] = (c[np.argmin(np.abs(c - a))] if len(c) else a, len(got) / max(1, len(idx)))
    # keep a monotonic chain of anchors (longest increasing, weighted by confidence)
    ids = [i for i in range(N) if anchor[i]]
    best, prev = {}, {}
    for a in ids:
        best[a], prev[a] = anchor[a][1], None
        for b in ids:
            if b >= a:
                break
            if anchor[b][0] < anchor[a][0] - 0.5 and best[b] + anchor[a][1] > best[a]:
                best[a], prev[a] = best[b] + anchor[a][1], b
    chain = []
    if ids:
        k = max(ids, key=lambda a: best[a])
        while k is not None:
            chain.append(k)
            k = prev[k]
    chain = chain[::-1]
    times = [None] * N
    for k in chain:
        times[k] = anchor[k][0]
    # the lines in between: on the voice onsets between the anchors, by syllables in voiced time
    syl = [syllables(l) for l in lines]
    bounds = [(-1, 0.0)] + [(k, times[k]) for k in chain] + [(N, dur)]
    total_syl = sum(syl)
    rate = cum[-1] / max(1, total_syl)
    for (ka, ta), (kb, tb) in zip(bounds, bounds[1:]):
        gap = list(range(ka + 1, kb))
        if not gap:
            continue
        # voiced time available between the two anchors, shared by syllables
        start = ta if ka >= 0 else (on[0] if len(on) else 0)
        va, vb = voiced(start), voiced(tb)
        s_from = syl[ka] if ka >= 0 else 0
        weights = [s_from] + [syl[i] for i in gap]
        if kb == N:
            vb = min(vb, va + rate * sum(weights) * 1.3)
        acc = 0
        tot = sum(weights) + (0 if kb < N else 0)
        cand = on[(on > start + 0.3) & (on < tb - 0.3)]
        for n_, i in enumerate(gap):
            acc += weights[n_]
            target_v = va + (vb - va) * acc / max(1, tot)
            f = int(np.searchsorted(cum, target_v))
            t = f * HOP
            c = cand[(cand >= t - 2.5) & (cand <= t + 2.5)]
            times[i] = c[np.argmin(np.abs(c - t))] if len(c) else t
        # keep order
        for n_ in range(1, len(gap)):
            if times[gap[n_]] <= times[gap[n_ - 1]]:
                times[gap[n_]] = times[gap[n_ - 1]] + 0.5
    return times, len(match) / max(1, len(L))


if __name__ == "__main__":
    lrc = json.load(open("lrc.json", encoding="utf8"))
    allerr = []
    verbose = os.environ.get("V")
    for sid in SIDS:
        truth = parse_lrc(lrc[sid]["synced"])
        asr = [tuple(x) for x in json.load(open(f"asr_whisper-tiny_{LEVEL}_{sid}.json"))]
        db = envelope(f"{sid}.vox.raw")
        act, runs = onsets(db)
        times, cover = place([t for _, t in truth], asr, act, runs, len(db) * HOP)
        err = np.array([abs(s - t) for s, (t, _) in zip(times, truth)])
        allerr += list(err)
        print(f"{sid}: matched {cover*100:.0f}%  median {np.median(err):.2f}s  <1s {np.mean(err<1)*100:.0f}%  <2s {np.mean(err<2)*100:.0f}%  max {err.max():.1f}")
        if verbose:
            for s, (t, txt) in zip(times, truth):
                print(f"   {t:6.1f} {s:6.1f} {s-t:+5.1f}  {txt[:40]}")
    a = np.array(allerr)
    print(f"v2 {LEVEL} {P} ALL: median {np.median(a):.2f}  <1s {np.mean(a<1)*100:.0f}%  <2s {np.mean(a<2)*100:.0f}%")
