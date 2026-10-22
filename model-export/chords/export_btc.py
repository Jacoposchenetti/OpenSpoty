"""BTC large-vocabulary chord model -> ONNX for the phone and the PC.

Input: log-CQT frames [batch, 108, 144] (as librosa: 22050 Hz, hop 2048,
24 bins/octave from C1); the dataset normalisation is inside the graph.
Output: logits [batch, 108, 170] (chord classes of utils.idx2voca_chord).
usage: python export_btc.py <btc repo> <out.onnx>
"""
import json
import sys

import numpy as np
import torch

sys.path.insert(0, sys.argv[1])
from btc_model import BTC_model  # noqa: E402
from utils.hparams import HParams  # noqa: E402
from utils.mir_eval_modules import idx2voca_chord  # noqa: E402

config = HParams.load(sys.argv[1] + "/run_config.yaml")
config.feature["large_voca"] = True
config.model["num_chords"] = 170
ck = torch.load(sys.argv[1] + "/test/btc_model_large_voca.pt", map_location="cpu", weights_only=False)
model = BTC_model(config=config.model)
model.load_state_dict(ck["model"])
model.eval()


class Wrapped(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.m = model  # a submodule, so its weights are exported as weights
        self.mean = float(ck["mean"])
        self.std = float(ck["std"])

    def forward(self, x):
        h, _ = self.m.self_attn_layers((x - self.mean) / self.std)
        return self.m.output_layer.output_projection(h)


w = Wrapped().eval()
x = torch.randn(3, 108, 144)
torch.onnx.export(w, x, sys.argv[2], input_names=["cqt"], output_names=["logits"],
                  dynamic_axes={"cqt": {0: "batch"}, "logits": {0: "batch"}}, opset_version=17)
names = idx2voca_chord()
json.dump([names[i] for i in range(170)], open(sys.argv[2] + ".labels.json", "w"))
print("mean/std", ck["mean"], ck["std"])

import onnxruntime as ort  # noqa: E402

s = ort.InferenceSession(sys.argv[2])
with torch.no_grad():
    ref = w(x).numpy()
got = s.run(None, {"cqt": x.numpy()})[0]
print("max diff", float(np.abs(ref - got).max()), "same argmax", float((ref.argmax(-1) == got.argmax(-1)).mean()))
