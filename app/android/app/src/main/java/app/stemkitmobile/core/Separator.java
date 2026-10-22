package app.stemkitmobile.core;

/**
 * Whole-song HT-Demucs separation with the exported ONNX core.
 *
 * Same chunking as demucs.apply.apply_model(split=True, overlap=0.25,
 * shifts=0), checked in model-export/reference_separate.py: 343980-sample
 * segments every 257985 samples, padding centred and filled from the
 * neighbouring audio (TensorChunk.padded), triangular cross-fade.
 *
 * Output is streamed: a sample is final once no later segment covers it,
 * so only one segment of accumulators is kept in memory per stem.
 */
public final class Separator {
    public static final int SEG = 343980;
    public static final int STRIDE = (int) ((1 - 0.25) * SEG); // 257985
    public static final int CHANNELS = 2;

    /** The ONNX core: {freq (S,4,BINS,T), time (S,2,SEG)} for one segment. */
    public interface Model {
        int sources();

        float[][] run(float[] mix, float[] spec) throws Exception;
    }

    /** Receives finished audio, in order: data[s][c][0..count). */
    public interface Sink {
        void write(float[][][] data, int count) throws Exception;
    }

    public interface Progress {
        /** @return false to cancel */
        boolean update(int done, int total);
    }

    /** Interleaved 16-bit stereo source: the decoded song (half the memory of floats). */
    public interface Source {
        int length();

        /** frames [from, from+count) as floats in [-1,1]; zero outside the song. */
        void read(int from, int count, float[][] dst);
    }

    private static float[] triangle() {
        float[] w = new float[SEG];
        int half = SEG / 2;
        for (int i = 0; i < half; i++) w[i] = i + 1;
        for (int i = 0; i < SEG - half; i++) w[half + i] = SEG - half - i;
        float max = 0;
        for (float v : w) max = Math.max(max, v);
        for (int i = 0; i < SEG; i++) w[i] /= max;
        return w;
    }

    public static int segments(int total) {
        return Math.max(1, (total + STRIDE - 1) / STRIDE);
    }

    /** @return false if cancelled */
    public static boolean separate(Source src, Model model, Sink sink, Progress progress) throws Exception {
        final int total = src.length();
        final int S = model.sources();
        final float[] weight = triangle();
        final Stft stft = new Stft();
        final int le = Stft.frames(SEG);
        // rolling accumulators covering [base, base + SEG)
        float[][][] acc = new float[S][CHANNELS][SEG];
        float[] accW = new float[SEG];
        int base = 0;
        float[][] seg = new float[CHANNELS][SEG];
        float[] mix = new float[CHANNELS * SEG];
        float[][] wave = new float[CHANNELS][SEG];
        int nSeg = segments(total);
        int done = 0;
        for (int offset = 0; offset < total; offset += STRIDE) {
            if (!progress.update(done, nSeg)) return false;
            int length = Math.min(SEG, total - offset);
            int delta = SEG - length;
            int start = offset - delta / 2;
            src.read(start, SEG, seg);
            for (int c = 0; c < CHANNELS; c++) System.arraycopy(seg[c], 0, mix, c * SEG, SEG);
            float[] spec = stft.spec(seg);
            float[][] outs = model.run(mix, spec);
            float[] freq = outs[0];
            float[] time = outs[1];
            int left = delta / 2; // center_trim back to the chunk length
            int rel = offset - base;
            for (int s = 0; s < S; s++) {
                stft.ispec(freq, s * CHANNELS * 2 * Stft.BINS * le, CHANNELS, le, SEG, wave);
                for (int c = 0; c < CHANNELS; c++) {
                    int tOff = (s * CHANNELS + c) * SEG;
                    float[] a = acc[s][c];
                    float[] wv = wave[c];
                    for (int i = 0; i < length; i++) {
                        a[rel + i] += weight[i] * (wv[left + i] + time[tOff + left + i]);
                    }
                }
            }
            for (int i = 0; i < length; i++) accW[rel + i] += weight[i];
            done++;
            // everything before the next segment's start is final
            int next = offset + STRIDE;
            int finalCount = (next < total ? next : total) - base;
            emit(acc, accW, finalCount, sink, S);
            shift(acc, accW, finalCount, S);
            base += finalCount;
        }
        progress.update(done, nSeg);
        return true;
    }

    private static void emit(float[][][] acc, float[] accW, int count, Sink sink, int S) throws Exception {
        float[][][] out = new float[S][CHANNELS][count];
        for (int s = 0; s < S; s++) {
            for (int c = 0; c < CHANNELS; c++) {
                float[] a = acc[s][c];
                float[] o = out[s][c];
                for (int i = 0; i < count; i++) o[i] = a[i] / accW[i];
            }
        }
        sink.write(out, count);
    }

    private static void shift(float[][][] acc, float[] accW, int count, int S) {
        int keep = SEG - count;
        for (int s = 0; s < S; s++) {
            for (int c = 0; c < CHANNELS; c++) {
                float[] a = acc[s][c];
                System.arraycopy(a, count, a, 0, keep);
                java.util.Arrays.fill(a, keep, SEG, 0f);
            }
        }
        System.arraycopy(accW, count, accW, 0, keep);
        java.util.Arrays.fill(accW, keep, SEG, 0f);
    }
}
