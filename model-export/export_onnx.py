"""Export the official HT-Demucs weights to ONNX for StemKit Mobile.

The STFT / iSTFT (complex numbers, not exportable) stay OUTSIDE the graph:
the phone computes them in Kotlin. The ONNX "core" takes

    mix  (1, 2, 343980)      raw stereo segment, 44.1 kHz
    spec (1, 4, 2048, 336)   complex-as-channels STFT of mix (see _spec)

and returns

    freq (1, S, 4, 2048, 336)  per-stem complex-as-channels spectrogram
    time (1, S, 2, 343980)     per-stem time-branch waveform

stem audio = time + iSTFT(freq). This file also checks, on a real song,
that (a) the split core matches demucs' own forward, (b) ONNX Runtime
matches PyTorch and (c) the numpy STFT/iSTFT that the Kotlin code mirrors
matches torch.

usage: python export_onnx.py <model-name> <song.wav> <out-dir>
"""
import math
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import torch.nn.functional as F

import demucs.pretrained
from demucs.htdemucs import HTDemucs

SEG = 343980
HOP = 1024
NFFT = 4096


def load_model(name):
    # demucs' pickled checkpoints need weights_only=False on newer torch
    orig = torch.load
    torch.load = lambda *a, **k: orig(*a, **{**k, "weights_only": False})
    try:
        bag = demucs.pretrained.get_model(name)
    finally:
        torch.load = orig
    models = getattr(bag, "models", [bag])
    assert len(models) == 1, f"{name} is a bag of {len(models)} models"
    model = models[0]
    assert isinstance(model, HTDemucs) and model.cac
    model.eval()
    return model


class Core(torch.nn.Module):
    """HTDemucs.forward between _magnitude and _mask (verbatim logic)."""

    def __init__(self, m: HTDemucs):
        super().__init__()
        self.m = m

    def forward(self, mix, mag):
        m = self.m
        length = mix.shape[-1]
        x = mag
        B, C, Fq, T = x.shape
        mean = x.mean(dim=(1, 2, 3), keepdim=True)
        std = x.std(dim=(1, 2, 3), keepdim=True)
        x = (x - mean) / (1e-5 + std)
        xt = mix
        meant = xt.mean(dim=(1, 2), keepdim=True)
        stdt = xt.std(dim=(1, 2), keepdim=True)
        xt = (xt - meant) / (1e-5 + stdt)

        saved, saved_t, lengths, lengths_t = [], [], [], []
        for idx, encode in enumerate(m.encoder):
            lengths.append(x.shape[-1])
            inject = None
            if idx < len(m.tencoder):
                lengths_t.append(xt.shape[-1])
                tenc = m.tencoder[idx]
                xt = tenc(xt)
                if not tenc.empty:
                    saved_t.append(xt)
                else:
                    inject = xt
            x = encode(x, inject)
            if idx == 0 and m.freq_emb is not None:
                frs = torch.arange(x.shape[-2], device=x.device)
                emb = m.freq_emb(frs).t()[None, :, :, None].expand_as(x)
                x = x + m.freq_emb_scale * emb
            saved.append(x)
        if m.crosstransformer:
            if m.bottom_channels:
                b, c, f, t = x.shape
                x = x.reshape(b, c, f * t)
                x = m.channel_upsampler(x)
                x = x.reshape(b, -1, f, t)
                xt = m.channel_upsampler_t(xt)
            x, xt = m.crosstransformer(x, xt)
            if m.bottom_channels:
                b, c, f, t = x.shape
                x = x.reshape(b, c, f * t)
                x = m.channel_downsampler(x)
                x = x.reshape(b, -1, f, t)
                xt = m.channel_downsampler_t(xt)
        for idx, decode in enumerate(m.decoder):
            skip = saved.pop(-1)
            x, pre = decode(x, skip, lengths.pop(-1))
            offset = m.depth - len(m.tdecoder)
            if idx >= offset:
                tdec = m.tdecoder[idx - offset]
                length_t = lengths_t.pop(-1)
                if tdec.empty:
                    pre = pre[:, :, 0]
                    xt, _ = tdec(pre, None, length_t)
                else:
                    skip = saved_t.pop(-1)
                    xt, _ = tdec(xt, skip, length_t)
        S = len(m.sources)
        x = x.view(B, S, -1, Fq, T)
        x = x * std[:, None] + mean[:, None]
        xt = xt.view(B, S, -1, length)
        xt = xt * stdt[:, None] + meant[:, None]
        return x, xt


# ----------------------------------------------------------- numpy STFT
# These two functions are the reference for StftCore.kt.

def hann(n):
    # torch.hann_window(n) is periodic
    return (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(n) / n)).astype(np.float64)


def np_spec(x):
    """x: (C, L) float -> (C*2, 2048, T) complex-as-channels, as HTDemucs._spec+_magnitude."""
    C, L = x.shape
    le = int(math.ceil(L / HOP))
    pad = HOP // 2 * 3
    x = np.pad(x, ((0, 0), (pad, pad + le * HOP - L)), mode="reflect")
    # torch.stft center=True, reflect: pad nfft//2 each side
    x = np.pad(x, ((0, 0), (NFFT // 2, NFFT // 2)), mode="reflect")
    win = hann(NFFT)
    n_frames = 1 + (x.shape[1] - NFFT) // HOP
    out = np.zeros((C, NFFT // 2 + 1, n_frames), dtype=np.complex128)
    for c in range(C):
        for t in range(n_frames):
            seg = x[c, t * HOP: t * HOP + NFFT] * win
            out[c, :, t] = np.fft.rfft(seg)
    out /= math.sqrt(NFFT)  # normalized=True
    z = out[:, :-1, 2: 2 + le]
    m = np.stack([z.real, z.imag], axis=1)  # (C, 2, F, T)
    return m.reshape(C * 2, NFFT // 2, le).astype(np.float32)


def np_ispec(m, length):
    """m: (C*2, 2048, T) complex-as-channels -> (C, length), as _mask(cac)+_ispec."""
    C2, Fr, T = m.shape
    C = C2 // 2
    z = m.reshape(C, 2, Fr, T)
    z = z[:, 0].astype(np.float64) + 1j * z[:, 1].astype(np.float64)
    z = np.pad(z, ((0, 0), (0, 1), (2, 2)))  # add Nyquist bin, 2 frames each side
    pad = HOP // 2 * 3
    le = HOP * int(math.ceil(length / HOP)) + 2 * pad
    win = hann(NFFT)
    n_frames = z.shape[2]
    full = NFFT + HOP * (n_frames - 1)
    y = np.zeros((C, full))
    wsum = np.zeros(full)
    for t in range(n_frames):
        wsum[t * HOP: t * HOP + NFFT] += win ** 2
    for c in range(C):
        for t in range(n_frames):
            frame = np.fft.irfft(z[c, :, t] * math.sqrt(NFFT), n=NFFT)
            y[c, t * HOP: t * HOP + NFFT] += frame * win
    y /= np.where(wsum > 1e-11, wsum, 1.0)
    y = y[:, NFFT // 2: NFFT // 2 + le]  # center=True trim, length=le
    return y[:, pad: pad + length].astype(np.float32)


def main():
    name, song, out_dir = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    out_dir.mkdir(parents=True, exist_ok=True)
    model = load_model(name)
    assert int(model.segment * model.samplerate) == SEG, model.segment
    print(f"{name}: sources={model.sources}")

    audio, sr = sf.read(str(song), dtype="float32", always_2d=True)
    assert sr == 44100
    start = 60 * sr
    mix_np = audio.T[:, start: start + SEG].copy()
    mix = torch.from_numpy(mix_np)[None]

    core = Core(model).eval()
    with torch.no_grad():
        ref = model(mix)  # demucs' own forward
        z = model._spec(mix)
        mag = model._magnitude(z)
        fx, tx = core(mix, mag)
        zout = model._mask(z, fx)
        split = model._ispec(zout, SEG).view_as(tx) + tx
    print("split core vs demucs forward: max abs diff", float((split - ref).abs().max()))

    # numpy STFT path (what Kotlin implements)
    mag_np = np_spec(mix_np)
    print("numpy spec vs torch: max abs diff", float(np.abs(mag_np - mag[0].numpy()).max()),
          "(max |spec|", float(np.abs(mag_np).max()), ")")
    S = len(model.sources)
    fx_np = fx[0].numpy()
    isp = np.stack([np_ispec(fx_np[s], SEG) for s in range(S)])
    torch_isp = model._ispec(zout, SEG)[0].numpy()
    print("numpy ispec vs torch: max abs diff", float(np.abs(isp - torch_isp).max()))

    onnx_path = out_dir / f"{name}.onnx"
    t0 = time.time()
    torch.onnx.export(
        core, (mix, mag), str(onnx_path), opset_version=17,
        input_names=["mix", "spec"], output_names=["freq", "time"],
        do_constant_folding=True,
    )
    print(f"exported {onnx_path} ({onnx_path.stat().st_size / 1e6:.1f} MB) in {time.time() - t0:.0f}s")

    import onnxruntime as ort
    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    t0 = time.time()
    of, ot = sess.run(None, {"mix": mix_np[None], "spec": mag_np[None]})
    print(f"onnxruntime one segment: {time.time() - t0:.2f}s")
    print("onnx freq vs torch: max abs diff", float(np.abs(of - fx.numpy()).max()))
    print("onnx time vs torch: max abs diff", float(np.abs(ot - tx.numpy()).max()))
    full_np = ot[0] + np.stack([np_ispec(of[0, s], SEG) for s in range(S)])
    err = np.abs(full_np - ref[0].numpy()).max()
    sig = np.abs(ref[0].numpy()).max()
    print(f"END-TO-END numpy+onnx vs demucs: max abs diff {err:.2e} (signal peak {sig:.3f})")

    # reference data for the Kotlin unit test
    np.save(out_dir / f"{name}_mix.npy", mix_np)
    np.save(out_dir / f"{name}_spec.npy", mag_np)
    np.save(out_dir / f"{name}_out.npy", full_np)


if __name__ == "__main__":
    main()
