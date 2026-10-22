package app.stemkitmobile.core;

import java.nio.FloatBuffer;
import java.util.HashMap;
import java.util.Map;

import ai.onnxruntime.NodeInfo;
import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OnnxValue;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;
import ai.onnxruntime.TensorInfo;

/** The exported HT-Demucs core (model-export/export_onnx.py) on ONNX Runtime. */
public final class OrtModel implements Separator.Model, AutoCloseable {
    private final OrtEnvironment env;
    private final OrtSession session;
    private final int sources;
    private final int frames = Stft.frames(Separator.SEG);

    public OrtModel(String path, int threads) throws OrtException {
        env = OrtEnvironment.getEnvironment();
        OrtSession.SessionOptions opts = new OrtSession.SessionOptions();
        opts.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
        if (threads > 0) opts.setIntraOpNumThreads(threads);
        session = env.createSession(path, opts);
        NodeInfo info = session.getOutputInfo().get("time");
        long[] shape = ((TensorInfo) info.getInfo()).getShape();
        sources = (int) shape[1];
    }

    @Override
    public int sources() {
        return sources;
    }

    @Override
    public float[][] run(float[] mix, float[] spec) throws OrtException {
        Map<String, OnnxTensor> in = new HashMap<>();
        try (OnnxTensor m = OnnxTensor.createTensor(env, FloatBuffer.wrap(mix), new long[] {1, Separator.CHANNELS, Separator.SEG});
             OnnxTensor s = OnnxTensor.createTensor(env, FloatBuffer.wrap(spec), new long[] {1, Separator.CHANNELS * 2, Stft.BINS, frames})) {
            in.put("mix", m);
            in.put("spec", s);
            try (OrtSession.Result r = session.run(in)) {
                return new float[][] {floats(r.get("freq").get()), floats(r.get("time").get())};
            }
        }
    }

    private static float[] floats(OnnxValue v) {
        FloatBuffer b = ((OnnxTensor) v).getFloatBuffer();
        float[] out = new float[b.remaining()];
        b.get(out);
        return out;
    }

    @Override
    public void close() throws OrtException {
        session.close();
    }
}
