"""Reference chord recognition with BTC (Park et al., ISMIR 2019, MIT) exactly as
its test.py does, to check the ONNX export and the Java CQT against.

usage: python btc_reference.py <btc repo> <song.wav> [...]
"""
import sys

import librosa
import numpy as np
import torch

sys.path.insert(0, sys.argv[1])
from btc_model import BTC_model  # noqa: E402
from utils.hparams import HParams  # noqa: E402
from utils.mir_eval_modules import idx2voca_chord  # noqa: E402

config = HParams.load(sys.argv[1] + "/run_config.yaml")
config.feature["large_voca"] = True
config.model["num_chords"] = 170
ck = torch.load(sys.argv[1] + "/test/btc_model_large_voca.pt", map_location="cpu")
model = BTC_model(config=config.model)
model.load_state_dict(ck["model"])
model.eval()
names = idx2voca_chord()


def features(wav):
    y, sr = librosa.load(wav, sr=22050, mono=True)
    chunks, cur, step = [], 0, int(22050 * 10.0)
    while len(y) > cur + step:
        chunks.append(librosa.cqt(y[cur:cur + step], sr=sr, n_bins=144, bins_per_octave=24, hop_length=2048))
        cur += step
    chunks.append(librosa.cqt(y[cur:], sr=sr, n_bins=144, bins_per_octave=24, hop_length=2048))
    return np.log(np.abs(np.concatenate(chunks, axis=1)) + 1e-6).T  # frames x 144


def predict(feat):
    f = (feat - ck["mean"]) / ck["std"]
    pad = 108 - f.shape[0] % 108
    f = np.pad(f, ((0, pad), (0, 0)))
    out = []
    with torch.no_grad():
        x = torch.tensor(f, dtype=torch.float32).unsqueeze(0)
        for t in range(f.shape[0] // 108):
            h, _ = model.self_attn_layers(x[:, 108 * t:108 * (t + 1), :])
            p, _ = model.output_layer(h)
            out.extend(p.squeeze().tolist())
    return np.array(out[: feat.shape[0]])


def segments(pred, hop=10.0 / 108, min_len=0.0):
    segs = []
    for i, c in enumerate(pred):
        if segs and segs[-1][1] == c:
            continue
        segs.append([i * hop, c])
    return [(round(t, 2), names[c]) for t, c in segs]


if __name__ == "__main__":
    for wav in sys.argv[2:]:
        feat = features(wav)
        np.save(wav + ".feat.npy", feat)
        pred = predict(feat)
        np.save(wav + ".pred.npy", pred)
        segs = segments(pred)
        print(wav, len(segs), "segmenti")
        print("  ", " ".join(f"{t}:{c}" for t, c in segs[:60]))
