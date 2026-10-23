"""Line start errors of the whole pipeline (ONNX Whisper + placement) on songs with known synced lyrics.

python eval_ref.py <dir with <id>.vox.raw and lrc.json> <.int8|""> <ids...>
"""
import json
import sys
import time

import numpy as np

sys.argv.insert(1, "word")  # v2 reads its argv
from align import HOP, envelope, onsets, parse_lrc  # noqa: E402
from v2 import place  # noqa: E402
from whisper_ref import Whisper  # noqa: E402

data, suffix, ids = sys.argv[2], sys.argv[3], sys.argv[4:]
w = Whisper(suffix)
lrc = json.load(open(f"{data}/lrc.json", encoding="utf8"))
allc, allr = [], []
for sid in ids:
    truth = parse_lrc(lrc[sid]["synced"])
    audio = np.fromfile(f"{data}/{sid}.vox.raw", dtype="<f4")
    db = envelope(f"{data}/{sid}.vox.raw")
    act, runs = onsets(db)
    voiced = lambda a, b: act[int(a / HOP): int(b / HOP)].mean() > 0.03
    t0 = time.time()
    first = next((r[0] * HOP for r in runs), 0)
    lang = {"yt-aEgq_OpMl5k": "en", "yt-XNm6weGYVmg": "en"}.get(sid, "it")  # the app takes it from the lyrics
    import os
    words = w.transcribe(audio, lang, None if os.environ.get('NOSKIP') else voiced)
    dt = time.time() - t0
    times, cover = place([t for _, t in truth], words, act, runs, len(db) * HOP)
    e = np.array([a - b for a, (b, _) in zip(times, truth)])
    c = np.abs(e - np.median(e))
    allr += list(np.abs(e))
    allc += list(c)
    print(f"{sid} [{lang}] words {len(words)} matched {cover*100:.0f}%  raw <2s {np.mean(np.abs(e)<2)*100:.0f}%  corrected <1s {np.mean(c<1)*100:.0f}% <2s {np.mean(c<2)*100:.0f}%  ({dt:.0f}s)", flush=True)
a, r = np.array(allc), np.array(allr)
print(f"{suffix or 'fp32'} ALL raw <1s {np.mean(r<1)*100:.0f}% <2s {np.mean(r<2)*100:.0f}% | corrected <1s {np.mean(a<1)*100:.0f}% <2s {np.mean(a<2)*100:.0f}%")
