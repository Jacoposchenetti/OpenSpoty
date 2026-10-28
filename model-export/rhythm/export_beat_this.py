"""Beat This! (Foscarin, Schlüter, Widmer, ISMIR 2024 — CPJKU, MIT) for the phone.

  beat_this.onnx   spect [1, T, 128] -> beat [1, T], downbeat [1, T] (logits, 50 frames/s)
  beat_mel.bin     513 x 128 float32: torchaudio's slaney mel filters (22.05 kHz, n_fft 1024, 30–11000 Hz)

Weights: safe-models/beat-this-final0 on Hugging Face (model.safetensors: no pickle).
Then ../fp16_weights.py makes the weights fp16 (same results). Run with the StemKit venv +
beat_this (pip install beat_this --no-deps) + onnx; reads config.json and model.safetensors here.
"""
import json
import os
import sys

import numpy as np
import torch
import torchaudio
from beat_this.model.beat_tracker import BeatThis
from safetensors.torch import load_file

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
src = sys.argv[1] if len(sys.argv) > 1 else HERE

model = BeatThis(**json.load(open(os.path.join(src, "config.json"))))
model.load_state_dict(load_file(os.path.join(src, "model.safetensors")), strict=False)  # rotary tables are rebuilt
model.eval()
# the rotary embeddings cache their tables by length: traced, a cached table would be frozen in the graph
from rotary_embedding_torch import RotaryEmbedding
for mod in model.modules():
    if isinstance(mod, RotaryEmbedding):
        mod.cache_if_possible = False


class Wrap(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, spect):
        # the model's own forward, with its sum head written out (its autocast context breaks the export)
        x = self.m.transformer_blocks(self.m.frontend(spect))
        bd = self.m.task_heads.beat_downbeat_lin(x)
        down = bd[..., 1]
        return bd[..., 0] + down, down


x = torch.randn(1, 1500, 128)
with torch.no_grad():
    torch.onnx.export(Wrap(model), (x,), f"{OUT}/beat_this.onnx", input_names=["spect"], output_names=["beat", "downbeat"],
                      dynamic_axes={"spect": {1: "t"}, "beat": {1: "t"}, "downbeat": {1: "t"}}, opset_version=17, dynamo=False)
    full = model(x)
    ref = (full["beat"], full["downbeat"])

mel = torchaudio.transforms.MelSpectrogram(sample_rate=22050, n_fft=1024, hop_length=441, f_min=30, f_max=11000, n_mels=128,
                                           mel_scale="slaney", normalized="frame_length", power=1)
np.asarray(mel.mel_scale.fb.numpy(), dtype="<f4").tofile(f"{OUT}/beat_mel.bin")  # [513, 128]

import onnxruntime as ort
s = ort.InferenceSession(f"{OUT}/beat_this.onnx")
b, d = s.run(None, {"spect": x.numpy()})
print("onnx vs torch:", float(np.abs(b - ref[0].numpy()).max()), float(np.abs(d - ref[1].numpy()).max()))
for f in sorted(os.listdir(OUT)):
    print(f, os.path.getsize(f"{OUT}/{f}") // 1024, "KB")
