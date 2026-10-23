"""Whisper tiny (OpenAI, MIT) for the phone: two ONNX models + the mel filters and the vocabulary.

  whisper_encoder.onnx  mel [1, 80, 3000]  ->  cross [8, 1500, 384]  (K, V of each decoder layer's cross attention)
  whisper_decoder.onnx  tokens [1, n], past [8, p, 384], cross  ->  logits [1, 51865] (last token), present [8, p+n, 384]
  whisper_mel.bin       80 x 201 float32 (little endian)
  whisper_vocab.json    {"tokens": [...], "eot": .., "sot": .., ...}: token -> text, bytes as \\u00XX

The decoder keeps its own self-attention cache (past/present), so each new token costs one position.
Run with the StemKit venv + transformers (see README in this folder); writes into out/.
"""
import json
import os
import sys

import numpy as np
import torch
from torch import nn
from transformers import WhisperForConditionalGeneration, WhisperProcessor

NAME = "openai/whisper-tiny"
OUT = os.path.join(os.path.dirname(__file__), "out")
os.makedirs(OUT, exist_ok=True)

hf = WhisperForConditionalGeneration.from_pretrained(NAME).eval()
proc = WhisperProcessor.from_pretrained(NAME)
cfg = hf.config
D, H, L = cfg.d_model, cfg.decoder_attention_heads, cfg.decoder_layers
HD = D // H


class Encoder(nn.Module):
    def __init__(self):
        super().__init__()
        self.enc = hf.model.encoder
        self.layers = hf.model.decoder.layers

    def forward(self, mel):
        h = self.enc(mel).last_hidden_state[0]  # [1500, D]
        kv = []
        for layer in self.layers:
            a = layer.encoder_attn
            kv.append(a.k_proj(h))
            kv.append(a.v_proj(h))
        return torch.stack(kv)  # [2L, 1500, D]


def heads(x):  # [T, D] -> [H, T, HD]
    return x.view(x.shape[0], H, HD).transpose(0, 1)


class Decoder(nn.Module):
    def __init__(self):
        super().__init__()
        self.dec = hf.model.decoder

    def forward(self, tokens, past, cross):
        d = self.dec
        n = tokens.shape[1]
        p = past.shape[1]
        x = d.embed_tokens(tokens[0]) + d.embed_positions.weight[p: p + n]
        mask = torch.full((n, p + n), float("-inf")).triu(p + 1)  # token i sees past + itself
        present = []
        for i, layer in enumerate(d.layers):
            r = x
            y = layer.self_attn_layer_norm(x)
            a = layer.self_attn
            q = a.q_proj(y) * a.scaling
            k = torch.cat([past[2 * i], a.k_proj(y)], 0)
            v = torch.cat([past[2 * i + 1], a.v_proj(y)], 0)
            present += [k, v]
            w = torch.softmax(heads(q) @ heads(k).transpose(1, 2) + mask, -1)
            x = r + a.out_proj((w @ heads(v)).transpose(0, 1).reshape(n, D))
            r = x
            y = layer.encoder_attn_layer_norm(x)
            c = layer.encoder_attn
            q = c.q_proj(y) * c.scaling
            w = torch.softmax(heads(q) @ heads(cross[2 * i]).transpose(1, 2), -1)
            x = r + c.out_proj((w @ heads(cross[2 * i + 1])).transpose(0, 1).reshape(n, D))
            r = x
            y = layer.final_layer_norm(x)
            x = r + layer.fc2(torch.nn.functional.gelu(layer.fc1(y)))
        x = d.layer_norm(x[-1:])
        logits = torch.nn.functional.linear(x, d.embed_tokens.weight)  # tied to the embedding: stored once
        return logits, torch.stack(present)


enc, dec = Encoder().eval(), Decoder().eval()
mel = torch.zeros(1, 80, 3000)
with torch.no_grad():
    cross = enc(mel)
    torch.onnx.export(enc, (mel,), f"{OUT}/whisper_encoder.onnx", input_names=["mel"], output_names=["cross"], opset_version=17)
    toks = torch.tensor([[50258, 50259, 50359]])
    past = torch.zeros(2 * L, 1, D)
    torch.onnx.export(dec, (toks, past, cross), f"{OUT}/whisper_decoder.onnx",
                      input_names=["tokens", "past", "cross"], output_names=["logits", "present"],
                      dynamic_axes={"tokens": {1: "n"}, "past": {1: "p"}, "present": {1: "pn"}}, opset_version=17)

    # the exporter stores the output projection as a transposed copy of the embedding (80 MB more):
    # read the embedding itself instead (Gemm with transB)
    import onnx
    from onnx import helper
    m = onnx.load(f"{OUT}/whisper_decoder.onnx")
    emb = "dec.embed_tokens.weight"
    for node in m.graph.node:
        if node.op_type == "MatMul":
            w = next((i for i in m.graph.initializer if i.name == node.input[1] and list(i.dims) == [D, cfg.vocab_size]), None)
            if w is not None:
                gemm = helper.make_node("Gemm", [node.input[0], emb], list(node.output), name="logits_gemm", transB=1)
                m.graph.node.insert(list(m.graph.node).index(node), gemm)
                m.graph.node.remove(node)
                m.graph.initializer.remove(w)
                break
    onnx.save(m, f"{OUT}/whisper_decoder.onnx")

    # check against Hugging Face on one step
    ref = hf(input_features=mel, decoder_input_ids=toks).logits[0, -1]
    got, pres = dec(toks, torch.zeros(2 * L, 0, D), cross)
    print("max diff vs HF:", float((ref - got[0]).abs().max()))

np.asarray(proc.feature_extractor.mel_filters.T, dtype="<f4").tofile(f"{OUT}/whisper_mel.bin")  # [80, 201]
tok = proc.tokenizer
byte_decoder = tok.byte_decoder
vocab = [""] * cfg.vocab_size
for t, i in tok.get_vocab().items():
    if i < len(vocab):
        try:
            vocab[i] = bytes(byte_decoder[c] for c in t).decode("latin-1")
        except KeyError:
            vocab[i] = t  # special tokens
special = {k: tok.convert_tokens_to_ids(v) for k, v in {
    "sot": "<|startoftranscript|>", "eot": "<|endoftext|>", "transcribe": "<|transcribe|>",
    "notimestamps": "<|notimestamps|>", "nospeech": "<|nocaptions|>", "it": "<|it|>", "en": "<|en|>", "ts0": "<|0.00|>"}.items()}
langs = {t[2:-2]: i for t, i in tok.get_vocab().items() if len(t) <= 9 and t.startswith("<|") and t[2:-2].isalpha() and t[2:-2].islower() and 50259 <= i < 50358}
gc = hf.generation_config
suppress = list(gc.suppress_tokens or [])
json.dump({"tokens": vocab, **special, "languages": langs, "suppress": suppress, "beginSuppress": list(gc.begin_suppress_tokens or [])}, open(f"{OUT}/whisper_vocab.json", "w", encoding="utf-8"), ensure_ascii=True)

if "--int8" in sys.argv:
    from onnx import TensorProto, numpy_helper
    from onnxruntime.quantization import QuantType, quantize_dynamic
    quantize_dynamic(f"{OUT}/whisper_encoder.onnx", f"{OUT}/whisper_encoder.int8.onnx", weight_type=QuantType.QInt8,
                     op_types_to_quantize=["MatMul"])  # the phone has no ConvInteger
    # decoder: the vocabulary matrix (token embedding = output projection, 51865 x 384) once, in int8 with a
    # scale per token, used by both ends; the other matrices by quantize_dynamic
    m = onnx.load(f"{OUT}/whisper_decoder.onnx")
    W = numpy_helper.to_array(next(i for i in m.graph.initializer if i.name == emb)).astype(np.float32)
    scale = np.abs(W).max(1) / 127.0 + 1e-12
    Wq = np.round(W / scale[:, None]).clip(-127, 127).astype(np.int8)
    g = m.graph
    g.initializer.remove(next(i for i in g.initializer if i.name == emb))
    g.initializer.extend([numpy_helper.from_array(np.ascontiguousarray(Wq.T), "vocab_q"),  # [384, V]
                          numpy_helper.from_array(scale.astype(np.float32), "vocab_scale")])  # [V]
    nodes = list(g.node)
    for node in nodes:
        if node.op_type == "Gather" and node.input[0] == emb:  # embedding lookup
            idx, out = node.input[1], node.output[0]
            new_nodes = [
                helper.make_node("Gather", ["vocab_q", idx], ["emb_q"], axis=1),  # [384, n]
                helper.make_node("Cast", ["emb_q"], ["emb_f"], to=TensorProto.FLOAT),
                helper.make_node("Transpose", ["emb_f"], ["emb_t"], perm=[1, 0]),
                helper.make_node("Gather", ["vocab_scale", idx], ["emb_s"]),
                helper.make_node("Unsqueeze", ["emb_s", "axis1"], ["emb_s2"]),
                helper.make_node("Mul", ["emb_t", "emb_s2"], [out]),
            ]
        elif node.name == "logits_gemm":  # x [1, 384] -> logits [1, V]
            x, out = node.input[0], node.output[0]
            new_nodes = [
                helper.make_node("DynamicQuantizeLinear", [x], ["x_q", "x_s", "x_z"]),
                helper.make_node("MatMulInteger", ["x_q", "vocab_q", "x_z"], ["lg_i"]),
                helper.make_node("Cast", ["lg_i"], ["lg_f"], to=TensorProto.FLOAT),
                helper.make_node("Mul", ["lg_f", "x_s"], ["lg_x"]),
                helper.make_node("Mul", ["lg_x", "vocab_scale"], [out]),
            ]
        else:
            continue
        at = list(g.node).index(node)
        g.node.remove(node)
        for k, nn_ in enumerate(new_nodes):
            g.node.insert(at + k, nn_)
    g.initializer.append(numpy_helper.from_array(np.array([1], np.int64), "axis1"))
    onnx.save(m, f"{OUT}/whisper_decoder.vq.onnx")  # only the vocabulary in int8
    onnx.save(m, f"{OUT}/whisper_decoder.tmp.onnx")
    quantize_dynamic(f"{OUT}/whisper_decoder.tmp.onnx", f"{OUT}/whisper_decoder.int8.onnx", weight_type=QuantType.QInt8,
                     op_types_to_quantize=["MatMul"])
    os.remove(f"{OUT}/whisper_decoder.tmp.onnx")
for f in sorted(os.listdir(OUT)):
    if f.startswith("whisper"):
        print(f, os.path.getsize(f"{OUT}/{f}") // 1024, "KB")
