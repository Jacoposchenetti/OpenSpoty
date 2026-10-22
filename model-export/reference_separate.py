"""Whole-song separation with the exported ONNX core: the exact algorithm the
Android code (Separator.kt) implements, checked against demucs apply_model.

Chunking mirrors demucs.apply.apply_model(split=True, overlap=0.25,
shifts=0): segments of 343980 samples every 257985, centred padding taken
from the neighbouring audio (TensorChunk.padded), triangular cross-fade.

usage: python reference_separate.py model.onnx song.wav seconds
"""
import sys
import time

import numpy as np
import soundfile as sf

from export_onnx import SEG, np_ispec, np_spec

STRIDE = int((1 - 0.25) * SEG)


def triangle():
    w = np.concatenate([np.arange(1, SEG // 2 + 1), np.arange(SEG - SEG // 2, 0, -1)]).astype(np.float32)
    return w / w.max()


def padded(mix, offset, length):
    total = mix.shape[1]
    delta = SEG - length
    start = offset - delta // 2
    end = start + SEG
    cs, ce = max(0, start), min(total, end)
    out = np.zeros((2, SEG), dtype=np.float32)
    out[:, cs - start: cs - start + (ce - cs)] = mix[:, cs:ce]
    return out, delta


def separate(sess, mix):
    total = mix.shape[1]
    weight = triangle()
    n_src = None
    out = None
    sum_w = np.zeros(total, dtype=np.float32)
    for offset in range(0, total, STRIDE):
        length = min(SEG, total - offset)
        seg, delta = padded(mix, offset, length)
        f, t = sess.run(None, {"mix": seg[None], "spec": np_spec(seg)[None]})
        if out is None:
            n_src = f.shape[1]
            out = np.zeros((n_src, 2, total), dtype=np.float32)
        y = t[0] + np.stack([np_ispec(f[0, s], SEG) for s in range(n_src)])
        # center_trim back to the chunk length
        left = delta // 2
        y = y[..., left: left + length]
        out[..., offset: offset + length] += weight[:length] * y
        sum_w[offset: offset + length] += weight[:length]
    return out / sum_w


def main():
    import onnxruntime as ort
    import torch
    from demucs.apply import apply_model
    from export_onnx import load_model

    onnx_path, song, seconds = sys.argv[1], sys.argv[2], float(sys.argv[3])
    audio, sr = sf.read(song, dtype="float32", always_2d=True)
    mix = audio.T[:, 30 * sr: int((30 + seconds) * sr)].copy()
    sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    t0 = time.time()
    ours = separate(sess, mix)
    print(f"onnx whole-song: {time.time() - t0:.1f}s for {seconds:.0f}s of audio")

    model = load_model("htdemucs_6s")
    with torch.no_grad():
        ref = apply_model(model, torch.from_numpy(mix)[None], shifts=0, split=True, overlap=0.25)[0].numpy()
    err = ours - ref
    snr = 10 * np.log10(np.sum(ref ** 2) / np.sum(err ** 2))
    print(f"vs demucs apply_model: max abs diff {np.abs(err).max():.2e}, SNR {snr:.1f} dB")
    np.save("out/ref_clip_mix.npy", mix)
    np.save("out/ref_clip_out.npy", ours)


if __name__ == "__main__":
    main()
