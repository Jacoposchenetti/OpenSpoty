"""Reference for core/Whisper.java: the ONNX models, step by step, as the app runs them.

transcribe(audio16k) -> [(word, start seconds)]: 30 s windows, greedy decoding with
Whisper's timestamp rules, words timed inside each segment by their length.
"""
import json
import os
import re
import unicodedata

import numpy as np
import onnxruntime as ort

OUT = os.path.join(os.path.dirname(__file__), "out")
SR, NFFT, HOP, CHUNK = 16000, 400, 160, 30


class Whisper:
    def __init__(self, suffix=".int8"):
        so = ort.SessionOptions()
        so.intra_op_num_threads = 4
        enc, dec = (suffix.split("+") + [suffix])[:2] if "+" in suffix else (suffix, suffix)
        self.enc = ort.InferenceSession(f"{OUT}/whisper_encoder{enc}.onnx", so)
        self.dec = ort.InferenceSession(f"{OUT}/whisper_decoder{dec}.onnx", so)
        self.mel = np.fromfile(f"{OUT}/whisper_mel.bin", dtype="<f4").reshape(80, 201)
        v = json.load(open(f"{OUT}/whisper_vocab.json", encoding="utf-8"))
        self.tokens, self.v = v["tokens"], v

    def log_mel(self, x):
        x = np.pad(x[: SR * CHUNK], (0, SR * CHUNK - min(len(x), SR * CHUNK)))
        x = np.pad(x, (NFFT // 2, NFFT // 2), mode="reflect")
        win = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(NFFT) / NFFT)  # periodic Hann
        n = 1 + (len(x) - NFFT) // HOP
        frames = np.stack([x[i * HOP: i * HOP + NFFT] * win for i in range(n)])
        spec = np.abs(np.fft.rfft(frames, axis=1)) ** 2  # [n, 201]
        m = np.log10(np.maximum(self.mel @ spec[:-1].T, 1e-10))  # [80, 3000]
        m = np.maximum(m, m.max() - 8.0)
        return ((m + 4.0) / 4.0).astype(np.float32)[None]

    def window(self, audio, lang):
        """one 30 s window: [(text, start, end)] segments and where the last complete one ended"""
        v = self.v
        cross = self.enc.run(None, {"mel": self.log_mel(audio)})[0]
        past = np.zeros((8, 0, 384), np.float32)
        prompt = [v["sot"], v["languages"].get(lang, v["it"]), v["transcribe"]]
        toks = list(prompt)
        out, feed = [], np.array([prompt], np.int64)
        ts0, eot = v["ts0"], v["eot"]
        for step in range(224):
            logits, past = self.dec.run(None, {"tokens": feed, "past": past, "cross": cross})
            lg = logits[0].astype(np.float64)
            gen = toks[len(prompt):]
            lg[v["notimestamps"]] = -np.inf
            lg[v["suppress"]] = -np.inf  # music symbols and the like
            if not gen or (len(gen) == 1 and gen[0] >= ts0):
                lg[v["beginSuppress"]] = -np.inf
            lg[v["sot"]: ts0] = -np.inf  # no other special tokens
            last_ts = len(gen) >= 1 and gen[-1] >= ts0
            prev_ts = len(gen) < 2 or gen[-2] >= ts0
            if last_ts:
                if prev_ts:
                    lg[ts0:] = -np.inf  # after a pair: text
                else:
                    lg[:eot] = -np.inf  # closing a segment: a timestamp (or the end)
            past_ts = [t for t in gen if t >= ts0]
            if past_ts:
                # timestamps never go back (and a new segment starts after the last one)
                lo = past_ts[-1] + (0 if last_ts and not prev_ts else 1)
                lg[ts0: lo] = -np.inf
            if not gen:
                lg[:ts0] = -np.inf  # the first token is a timestamp
                lg[ts0 + 51:] = -np.inf  # within the first second
            # more probable timestamp than any text: take a timestamp
            p = np.exp(lg - lg.max())
            p /= p.sum()
            if p[ts0:].sum() > p[:ts0].max():
                lg[:ts0] = -np.inf
            t = int(np.argmax(lg))
            if t == eot:
                break
            toks.append(t)
            feed = np.array([[t]], np.int64)
        gen = toks[len(prompt):]
        segs, start, text, end = [], None, [], 0.0
        for t in gen:
            if t >= ts0:
                sec = (t - ts0) * 0.02
                if start is None:
                    start = sec
                else:
                    if text:
                        segs.append((self.text(text), start, sec))
                        end = sec
                    start, text = None, []
            else:
                text.append(t)
        return segs, end

    def text(self, ids):
        return "".join(self.tokens[i] for i in ids).encode("latin-1").decode("utf-8", "replace")

    def detect(self, audio):
        v = self.v
        cross = self.enc.run(None, {"mel": self.log_mel(audio)})[0]
        logits, _ = self.dec.run(None, {"tokens": np.array([[v["sot"]]], np.int64), "past": np.zeros((8, 0, 384), np.float32), "cross": cross})
        ids = {k: i for k, i in v["languages"].items()}
        return max(ids, key=lambda k: logits[0][ids[k]])

    def transcribe(self, audio, lang=None, voiced=None):
        """voiced(t0, t1) -> bool: skip the windows with no singing"""
        words, pos, total = [], 0.0, len(audio) / SR
        while pos < total - 0.5:
            if voiced and not voiced(pos, pos + CHUNK):
                pos += CHUNK
                continue
            seg = audio[int(pos * SR): int((pos + CHUNK) * SR)]
            lg = lang or self.detect(seg)
            segs, end = self.window(seg, lg)
            for txt, a, b in segs:
                ws = norm_words(txt)
                n = max(1, sum(len(w) for w in ws))
                acc = 0
                for w in ws:
                    words.append((w, pos + a + (b - a) * acc / n))
                    acc += len(w)
            pos += end if end > 1.0 else CHUNK
        return words


def norm_words(s):
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return [w for w in re.split(r"[^a-z0-9]+", s) if w]
