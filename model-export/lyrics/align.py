"""Prototype: place unsynced lyric lines on the vocal track (to port to TS)."""
import json, re, sys
import numpy as np

HOP = 0.02  # s per envelope frame


def envelope(raw):
    x = np.fromfile(raw, dtype="<f4")
    n = int(16000 * HOP)
    frames = x[: len(x) // n * n].reshape(-1, n)
    rms = np.sqrt((frames ** 2).mean(1) + 1e-12)
    return 20 * np.log10(rms + 1e-9)


def onsets(db, gap=0.30, min_run=0.12):
    """starts of sung phrases: where the voice comes back after a pause"""
    k = max(1, int(0.06 / HOP))
    sm = np.convolve(db, np.ones(k) / k, mode="same")
    loud = np.percentile(sm, 95)
    act = sm > loud - 22
    # active runs, small gaps closed
    runs = []
    i = 0
    N = len(act)
    while i < N:
        if act[i]:
            j = i
            while j < N and act[j]:
                j += 1
            runs.append([i, j])
            i = j
        else:
            i += 1
    merged = []
    for r in runs:
        if merged and (r[0] - merged[-1][1]) * HOP < gap:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    merged = [r for r in merged if (r[1] - r[0]) * HOP >= min_run]
    return act, merged


VOW = re.compile(r"[aeiouyàèéìíòóùú]+", re.I)


def syllables(line):
    return max(1, len(VOW.findall(line)))


def align(lines, act, runs):
    """DP: each line starts at a phrase onset (or is sung straight after the previous one);
    the voiced time between two starts should match the lines' syllables."""
    cum_act = np.concatenate([[0], np.cumsum(act)]) * HOP  # voiced seconds before frame i
    on = [r[0] for r in runs]
    A = [cum_act[o] for o in on]
    M = len(on)
    syl = [syllables(l) for l in lines]
    N = len(lines)
    S = np.concatenate([[0], np.cumsum(syl)])
    total_voiced = cum_act[-1]
    rate = total_voiced / S[-1]  # voiced seconds per syllable, whole song
    INF = 1e18
    cost = np.full((N, M), INF)
    back = {}
    def seg_cost(i, j, k, l):
        exp = rate * (S[k] - S[i])
        got = A[l] - A[j]
        return abs(np.log((got + 0.5) / (exp + 0.5))) * 4 + 0.6 * (l - j - 1) + 1.2 * (k - i - 1)
    for j in range(M):
        cost[0, j] = abs(A[j]) / (rate * 4 + 1e-9) * 0.5 + 0.3 * j
    for i in range(N):
        for j in range(M):
            c = cost[i, j]
            if c >= INF:
                continue
            for k in range(i + 1, min(N, i + 4)):
                for l in range(j + 1, min(M, j + 12)):
                    v = c + seg_cost(i, j, k, l)
                    if v < cost[k, l]:
                        cost[k, l] = v
                        back[(k, l)] = (i, j)
    # end: the last line's syllables against the voice left
    best, bj = INF, None
    for j in range(M):
        if cost[N - 1, j] >= INF:
            continue
        exp = rate * (S[N] - S[N - 1])
        got = total_voiced - A[j]
        v = cost[N - 1, j] + abs(np.log((got + 0.5) / (exp + 0.5))) * 2
        if v < best:
            best, bj = v, j
    path = {N - 1: bj}
    k, l = N - 1, bj
    while (k, l) in back:
        i, j = back[(k, l)]
        path[i] = j
        k, l = i, j
    # times: lines with an onset start there; the others in between, by syllables in voiced time
    times = [None] * N
    for i, j in path.items():
        times[i] = on[j] * HOP
    keys = sorted(path)
    for a, b in zip(keys, keys[1:]):
        for m in range(a + 1, b):
            # voiced-time interpolation
            fa, fb = on[path[a]], on[path[b]]
            target = cum_act[fa] + (cum_act[fb] - cum_act[fa]) * (S[m] - S[a]) / (S[b] - S[a])
            f = int(np.searchsorted(cum_act, target))
            times[m] = f * HOP
    if keys and keys[0] > 0:
        for m in range(keys[0]):
            times[m] = on[path[keys[0]]] * HOP
    return times


def parse_lrc(t):
    out = []
    for line in t.splitlines():
        m = re.match(r"\[(\d+):(\d+(?:\.\d+)?)\](.*)", line)
        if m and m.group(3).strip():
            out.append((int(m.group(1)) * 60 + float(m.group(2)), m.group(3).strip()))
    return out


if __name__ == "__main__":
    lrc = json.load(open("lrc.json", encoding="utf8"))
    allerr = []
    for sid in sys.argv[1:]:
        if sid not in lrc or not lrc[sid]["synced"]:
            continue
        truth = parse_lrc(lrc[sid]["synced"])
        db = envelope(f"{sid}.vox.raw")
        act, runs = onsets(db)
        est = align([t for _, t in truth], act, runs)
        err = np.array([abs(e - t) for e, (t, _) in zip(est, truth)])
        allerr += list(err)
        print(f"{sid}: lines {len(truth)} onsets {len(runs)}  median {np.median(err):.2f}s  <1s {np.mean(err<1)*100:.0f}%  <2s {np.mean(err<2)*100:.0f}%  max {err.max():.1f}")
    a = np.array(allerr)
    print(f"ALL: median {np.median(a):.2f}  <1s {np.mean(a<1)*100:.0f}%  <2s {np.mean(a<2)*100:.0f}%")
