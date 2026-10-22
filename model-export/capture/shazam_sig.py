"""Shazam signature (port of SongRec's algorithm.rs / signature_format.rs, GPLv3)
and recognition request, as reference for ShazamSignature.java.

usage: python shazam_sig.py <audio> [--send]   (needs ffmpeg on PATH or FFMPEG env)
"""
import base64
import json
import os
import struct
import subprocess
import sys
import time
import urllib.request
import uuid
import zlib

import numpy as np

HANN = (0.5 - 0.5 * np.cos(2 * np.pi * (np.arange(2048) + 1) / 2049)).astype(np.float32)


def signature(samples_f32_16k):
    s16 = np.clip(np.round(samples_f32_16k * 32767), -32768, 32767).astype(np.int16)
    ring = np.zeros(2048, np.int16)
    ri = 0
    fft_out = np.zeros((256, 1025), np.float32)
    fi = 0
    spread = np.zeros((256, 1025), np.float32)
    si = 0
    done = 0
    bands = [[], [], [], []]
    for c in range(len(s16) // 128):
        chunk = s16[c * 128:(c + 1) * 128]
        ring[ri:ri + 128] = chunk
        ri = (ri + 128) & 2047
        reordered = ring[(np.arange(2048) + ri) & 2047].astype(np.float32) * HANN
        spec = np.fft.rfft(reordered.astype(np.float64))
        mag = ((spec.real ** 2 + spec.imag ** 2) / (1 << 17)).astype(np.float32)
        fft_out[fi] = np.maximum(mag, 1e-10)
        fi = (fi + 1) & 255
        # spreading
        cur = fft_out[(fi - 1) & 255].copy()
        for p in range(1023):
            cur[p] = max(cur[p], cur[p + 1], cur[p + 2])
        spread[si] = cur
        for back in (1, 3, 6):
            k = (si - back) & 255
            spread[k] = np.maximum(spread[k], cur)
        si = (si + 1) & 255
        done += 1
        if done >= 46:
            f46 = fft_out[(fi - 46) & 255]
            f49 = spread[(si - 49) & 255]
            for b in range(10, 1015):
                v = f46[b]
                if not (v >= 1 / 64 and v >= f49[b - 1]):
                    continue
                m = 0.0
                for o in (-10, -7, -4, -3, 1, 2, 5, 8):
                    m = max(m, f49[b + o])
                if not v > m:
                    continue
                m2 = m
                for o in (-53, -45, 165, 172, 179, 186, 193, 200, 214, 221, 228, 235, 242, 249):
                    m2 = max(m2, spread[(si + o) & 255][b - 1])
                if not v > m2:
                    continue
                pm = max(np.log(v), 1 / 64) * 1477.3 + 6144
                pb = max(np.log(f46[b - 1]), 1 / 64) * 1477.3 + 6144
                pa = max(np.log(f46[b + 1]), 1 / 64) * 1477.3 + 6144
                v1 = pm * 2 - pb - pa
                v2 = (pa - pb) * 32 / v1
                corrected = (b * 64 + int(v2)) & 0xFFFF
                hz = corrected * (16000 / 2 / 1024 / 64)
                hzi = int(hz)
                band = 0 if 250 <= hzi <= 519 else 1 if 520 <= hzi <= 1449 else 2 if 1450 <= hzi <= 3499 else 3 if 3500 <= hzi <= 5500 else -1
                if band < 0:
                    continue
                bands[band].append((done - 46, int(pm) & 0xFFFF, corrected))
    return bands, len(samples_f32_16k)


def encode(bands, n):
    body = b""
    for bi, peaks in enumerate(bands):
        if not peaks:
            continue
        buf = b""
        last = 0
        for p, mag, freq in peaks:
            if p - last >= 255:
                buf += b"\xff" + struct.pack("<I", p)
                last = p
            buf += struct.pack("<BHH", p - last, mag, freq)
            last = p
        body += struct.pack("<II", 0x60030040 + bi, len(buf)) + buf + b"\0" * ((4 - len(buf) % 4) % 4)
    head = struct.pack("<IIII3IIIIII", 0xCAFE2580, 0, 0, 0x94119C00, 0, 0, 0, 3 << 27, 0, 0, n + int(16000 * 0.24), (15 << 19) + 0x40000)
    data = bytearray(head + struct.pack("<II", 0x40000000, 0) + body)
    size = len(data) - 48
    struct.pack_into("<I", data, 8, size)
    struct.pack_into("<I", data, 52, size)
    struct.pack_into("<I", data, 4, zlib.crc32(bytes(data[8:])) & 0xFFFFFFFF)
    return bytes(data)


def recognize(sig, n):
    ts = int(time.time() * 1000) & 0xFFFFFFFF
    post = {
        "geolocation": {"altitude": 300, "latitude": 45, "longitude": 2},
        "signature": {"samplems": int(n / 16000 * 1000), "timestamp": ts, "uri": "data:audio/vnd.shazam.sig;base64," + base64.b64encode(sig).decode()},
        "timestamp": ts,
        "timezone": "Europe/Rome",
    }
    url = (f"https://amp.shazam.com/discovery/v5/it/IT/android/-/tag/{str(uuid.uuid4()).upper()}/{uuid.uuid4()}"
           "?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&video=v3")
    req = urllib.request.Request(url, data=json.dumps(post).encode(), headers={
        "Content-Type": "application/json", "Content-Language": "it_IT",
        "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 14; Pixel 8 Build/AP2A.240805.005)"})
    return json.loads(urllib.request.urlopen(req, timeout=20).read())


if __name__ == "__main__":
    ff = os.environ.get("FFMPEG", "ffmpeg")
    raw = subprocess.run([ff, "-v", "error", "-i", sys.argv[1], "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True, check=True).stdout
    y = np.frombuffer(raw, np.float32)
    mid = len(y) // 2
    seg = y[mid - 6 * 16000: mid + 6 * 16000] if len(y) > 12 * 16000 else np.pad(y, (0, 12 * 16000 - len(y)))
    bands, n = signature(seg)
    sig = encode(bands, n)
    open(sys.argv[1] + ".sig", "wb").write(sig)
    print("peaks per band", [len(b) for b in bands], "bytes", len(sig))
    if "--send" in sys.argv:
        r = recognize(sig, n)
        t = r.get("track") or {}
        print("risultato:", t.get("title"), "-", t.get("subtitle"), "| matches", len(r.get("matches", [])))
