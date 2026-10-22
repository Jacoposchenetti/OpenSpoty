"""Store the ONNX weights as fp16 (half the download/APK size).

Every large float32 initializer becomes an fp16 initializer followed by a
Cast back to float32, so all the math still runs in fp32; ONNX Runtime
folds the casts once when the session is created.

usage: python fp16_weights.py in.onnx out.onnx mix.npy spec.npy out.npy
"""
import sys

import numpy as np
import onnx
from onnx import helper, numpy_helper


def main():
    src, dst = sys.argv[1], sys.argv[2]
    model = onnx.load(src)
    g = model.graph
    new_inits, casts = [], []
    for init in g.initializer:
        if init.data_type == onnx.TensorProto.FLOAT and np.prod(init.dims) >= 1024:
            arr = numpy_helper.to_array(init).astype(np.float16)
            half = numpy_helper.from_array(arr, init.name + "__fp16")
            new_inits.append(half)
            casts.append(helper.make_node("Cast", [half.name], [init.name], to=onnx.TensorProto.FLOAT,
                                          name=init.name + "__cast"))
        else:
            new_inits.append(init)
    del g.initializer[:]
    g.initializer.extend(new_inits)
    nodes = list(g.node)
    del g.node[:]
    g.node.extend(casts + nodes)
    onnx.save(model, dst)
    print(f"{len(casts)} weights -> fp16, saved {dst}")

    if len(sys.argv) > 3:
        import math
        import onnxruntime as ort
        sys.path.insert(0, ".")
        from export_onnx import np_ispec, SEG
        mix, spec, ref = (np.load(p) for p in sys.argv[3:6])
        sess = ort.InferenceSession(dst, providers=["CPUExecutionProvider"])
        f, t = sess.run(None, {"mix": mix[None], "spec": spec[None]})
        full = t[0] + np.stack([np_ispec(f[0, s], SEG) for s in range(f.shape[1])])
        err = full - ref
        snr = 10 * math.log10(np.sum(ref ** 2) / np.sum(err ** 2))
        print(f"fp16 weights vs fp32: max abs diff {np.abs(err).max():.2e}, SNR {snr:.1f} dB")


if __name__ == "__main__":
    main()
