package app.stemkitmobile.core;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;

import java.nio.FloatBuffer;
import java.util.ArrayList;
import java.util.List;

/**
 * Chord recognition with BTC (Park et al., ISMIR 2019, MIT; large vocabulary:
 * 12 roots x 14 qualities + N). The CQT is librosa's, computed single-rate but
 * like BTC in independent 10-second pieces: checked against librosa in
 * model-export/chords (direct_cqt.py: same chords on 100% of the frames).
 *
 * Decoding (postproc.py): windows of 108 frames every 54, averaged with a Hann
 * weight, then Viterbi with a switching cost, so a chord can't flicker.
 */
public final class ChordRecognizer implements AutoCloseable {
    public static final int SR = 22050;
    private static final int HOP = 2048, BINS = 144, BPO = 24, WIN = 108, STEP = 54;
    private static final double FMIN = 32.70319566257483;
    /** seconds per feature frame (BTC's time base: 108 frames per 10-second piece) */
    public static final double FRAME_SEC = 10.0 / WIN;
    private static final double SWITCH = -8.0;
    private static final String[] ROOTS = {"C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"};
    private static final String[] QUALITIES = {"min", "maj", "dim", "aug", "min6", "maj6", "min7", "minmaj7", "maj7", "7", "dim7", "hdim7", "sus2", "sus4"};

    /** class index -> "A:min7" style label (BTC's idx2voca_chord); 168 = X, 169 = N (no chord) */
    public static String label(int c) {
        if (c == 168) return "X";
        if (c >= 169) return "N";
        String q = QUALITIES[c % 14];
        return ROOTS[c / 14] + ("maj".equals(q) ? "" : ":" + q);
    }

    public interface Progress {
        void update(float fraction);
    }

    /** one chord: from start (seconds), class index, mean probability */
    public static final class Segment {
        public final double start;
        public final int chord;
        public final float confidence;

        Segment(double start, int chord, float confidence) {
            this.start = start;
            this.chord = chord;
            this.confidence = confidence;
        }
    }

    private final OrtEnvironment env;
    private final OrtSession session;

    public ChordRecognizer(byte[] model) throws OrtException {
        env = OrtEnvironment.getEnvironment();
        OrtSession.SessionOptions o = new OrtSession.SessionOptions();
        o.setIntraOpNumThreads(Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors() - 1)));
        session = env.createSession(model, o);
    }

    @Override
    public void close() throws OrtException {
        session.close();
    }

    /** chords of a mono 22.05 kHz signal */
    public List<Segment> recognize(float[] mono, Progress progress) throws OrtException {
        float[][] feat = cqt(mono, f -> progress.update(f * 0.7f));
        float[][] probs = probabilities(feat, f -> progress.update(0.7f + f * 0.28f));
        int[] path = viterbi(probs);
        List<Segment> out = new ArrayList<>();
        int start = 0;
        for (int i = 1; i <= path.length; i++) {
            if (i == path.length || path[i] != path[start]) {
                double conf = 0;
                for (int k = start; k < i; k++) conf += probs[k][path[start]];
                out.add(new Segment(start * FRAME_SEC, path[start], (float) (conf / (i - start))));
                start = i;
            }
        }
        progress.update(1f);
        return out;
    }

    // ------------------------------------------------------------ CQT

    private static final class Basis {
        final int nfft;
        final int[][] idx = new int[BINS][];
        final float[][] re = new float[BINS][], im = new float[BINS][];
        final double[] scale = new double[BINS]; // 1/sqrt(length)

        Basis() {
            double r = Math.pow(2.0, 2.0 / BPO);
            double alpha = (r - 1) / (r + 1);
            double[] freqs = new double[BINS], lengths = new double[BINS];
            double maxLen = 0;
            for (int b = 0; b < BINS; b++) {
                freqs[b] = FMIN * Math.pow(2.0, b / (double) BPO);
                lengths[b] = (1.0 / alpha) * SR / freqs[b];
                maxLen = Math.max(maxLen, lengths[b]);
            }
            nfft = Integer.highestOneBit((int) Math.ceil(maxLen) - 1) << 1;
            Fft fft = new Fft(nfft);
            double[] fr = new double[nfft], fi = new double[nfft];
            for (int b = 0; b < BINS; b++) {
                double L = lengths[b];
                long lo = (long) Math.floor(-L / 2), hi = (long) Math.floor(L / 2);
                int len = (int) (hi - lo);
                java.util.Arrays.fill(fr, 0);
                java.util.Arrays.fill(fi, 0);
                double norm = 0;
                for (int i = 0; i < len; i++) norm += 0.5 - 0.5 * Math.cos(2 * Math.PI * i / len);
                int off = (nfft - len) / 2;
                for (int i = 0; i < len; i++) {
                    double w = (0.5 - 0.5 * Math.cos(2 * Math.PI * i / len)) / norm;
                    double ph = 2 * Math.PI * freqs[b] * (lo + i) / SR;
                    fr[off + i] = w * Math.cos(ph);
                    fi[off + i] = w * Math.sin(ph);
                }
                fft.transform(fr, fi, false);
                int half = nfft / 2 + 1;
                double s = L / nfft, total = 0;
                double[] mag = new double[half];
                for (int k = 0; k < half; k++) {
                    mag[k] = Math.hypot(fr[k], fi[k]) * s;
                    total += mag[k];
                }
                // drop the smallest 1% of the row's mass (librosa's sparsity)
                Integer[] order = new Integer[half];
                for (int k = 0; k < half; k++) order[k] = k;
                java.util.Arrays.sort(order, (x, y) -> Double.compare(mag[x], mag[y]));
                boolean[] keep = new boolean[half];
                double acc = 0;
                int kept = 0;
                for (int j = 0; j < half; j++) {
                    acc += mag[order[j]];
                    if (acc / total > 0.01) {
                        keep[order[j]] = true;
                        kept++;
                    }
                }
                idx[b] = new int[kept];
                re[b] = new float[kept];
                im[b] = new float[kept];
                int n = 0;
                for (int k = 0; k < half; k++) {
                    if (!keep[k]) continue;
                    idx[b][n] = k;
                    re[b][n] = (float) (fr[k] * s);
                    im[b][n] = (float) (fi[k] * s);
                    n++;
                }
                scale[b] = 1.0 / Math.sqrt(L);
            }
        }
    }

    private static Basis basis;

    private static synchronized Basis basis() {
        if (basis == null) basis = new Basis();
        return basis;
    }

    /** log-CQT frames [n][144], in BTC's 10-second pieces */
    static float[][] cqt(float[] y, Progress progress) {
        Basis B = basis();
        int piece = SR * 10;
        List<float[]> frames = new ArrayList<>();
        int pieces = Math.max(1, (y.length + piece - 1) / piece);
        int cur = 0, done = 0;
        Fft fft = new Fft(B.nfft);
        double[] re = new double[B.nfft], im = new double[B.nfft];
        while (true) {
            boolean last = y.length <= cur + piece;
            int len = last ? y.length - cur : piece;
            int n = 1 + len / HOP;
            // two frames per complex FFT: one in the real part, one in the imaginary part
            for (int m = 0; m < n; m += 2) {
                fill(y, cur, len, m, B.nfft, re);
                boolean pair = m + 1 < n;
                if (pair) fill(y, cur, len, m + 1, B.nfft, im);
                else java.util.Arrays.fill(im, 0);
                fft.transform(re, im, false);
                frames.add(project(B, re, im, true));
                if (pair) frames.add(project(B, re, im, false));
                // the transform overwrote re/im: refilled next round
            }
            done++;
            progress.update(Math.min(1f, done / (float) pieces));
            if (last) break;
            cur += piece;
        }
        return frames.toArray(new float[0][]);
    }

    /** frame m of a piece: centred (n_fft/2 zeros of padding), zeros past the end */
    private static void fill(float[] y, int start, int len, int m, int nfft, double[] dst) {
        int from = m * HOP - nfft / 2;
        for (int i = 0; i < nfft; i++) {
            int k = from + i;
            dst[i] = k >= 0 && k < len ? y[start + k] : 0;
        }
    }

    /**
     * |basis · X| for one of the two packed frames. With z = a + i·b, the
     * spectra are A[k] = (Z[k] + conj Z[N-k]) / 2 and B[k] = (Z[k] - conj Z[N-k]) / 2i.
     */
    private static float[] project(Basis B, double[] zr, double[] zi, boolean first) {
        int n = B.nfft;
        float[] out = new float[BINS];
        for (int b = 0; b < BINS; b++) {
            double sr = 0, si = 0;
            int[] idx = B.idx[b];
            float[] br = B.re[b], bi = B.im[b];
            for (int j = 0; j < idx.length; j++) {
                int k = idx[j];
                int nk = k == 0 ? 0 : n - k;
                double xr, xi;
                if (first) {
                    xr = 0.5 * (zr[k] + zr[nk]);
                    xi = 0.5 * (zi[k] - zi[nk]);
                } else {
                    xr = 0.5 * (zi[k] + zi[nk]);
                    xi = -0.5 * (zr[k] - zr[nk]);
                }
                sr += br[j] * xr - bi[j] * xi;
                si += br[j] * xi + bi[j] * xr;
            }
            out[b] = (float) Math.log(Math.hypot(sr, si) * B.scale[b] + 1e-6);
        }
        return out;
    }

    // ------------------------------------------------------------ model + decoding

    private float[][] probabilities(float[][] feat, Progress progress) throws OrtException {
        int n = feat.length;
        int total = n + ((WIN - n % WIN) % WIN) + WIN;
        float silence = (float) Math.log(1e-6);
        List<Integer> starts = new ArrayList<>();
        for (int s = 0; s + WIN <= total; s += STEP) starts.add(s);
        double[][] acc = new double[total][170];
        double[] cnt = new double[total];
        double[] w = new double[WIN];
        for (int i = 0; i < WIN; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 1) / (WIN + 1)) + 1e-3;
        int batch = 8;
        for (int b0 = 0; b0 < starts.size(); b0 += batch) {
            int nb = Math.min(batch, starts.size() - b0);
            FloatBuffer in = FloatBuffer.allocate(nb * WIN * BINS);
            for (int j = 0; j < nb; j++) {
                int s = starts.get(b0 + j);
                for (int t = 0; t < WIN; t++) {
                    int f = s + t;
                    if (f < n) in.put(feat[f]);
                    else for (int k = 0; k < BINS; k++) in.put(silence);
                }
            }
            in.rewind();
            try (OnnxTensor x = OnnxTensor.createTensor(env, in, new long[]{nb, WIN, BINS});
                 OrtSession.Result r = session.run(java.util.Collections.singletonMap("cqt", x))) {
                float[][][] logits = (float[][][]) r.get(0).getValue();
                for (int j = 0; j < nb; j++) {
                    int s = starts.get(b0 + j);
                    for (int t = 0; t < WIN; t++) {
                        float[] l = logits[j][t];
                        double max = Double.NEGATIVE_INFINITY, sum = 0;
                        for (float v : l) max = Math.max(max, v);
                        double[] p = new double[170];
                        for (int c = 0; c < 170; c++) sum += p[c] = Math.exp(l[c] - max);
                        double[] a = acc[s + t];
                        for (int c = 0; c < 170; c++) a[c] += p[c] / sum * w[t];
                        cnt[s + t] += w[t];
                    }
                }
            }
            progress.update((b0 + nb) / (float) starts.size());
        }
        float[][] out = new float[n][170];
        for (int f = 0; f < n; f++) for (int c = 0; c < 170; c++) out[f][c] = (float) (acc[f][c] / cnt[f]);
        return out;
    }

    private static int[] viterbi(float[][] p) {
        int n = p.length, k = 170;
        if (n == 0) return new int[0];
        double[] score = new double[k];
        int[][] back = new int[n][k];
        for (int c = 0; c < k; c++) score[c] = Math.log(p[0][c] + 1e-9);
        double[] next = new double[k];
        for (int t = 1; t < n; t++) {
            int best = 0;
            for (int c = 1; c < k; c++) if (score[c] > score[best]) best = c;
            double sw = score[best] + SWITCH;
            for (int c = 0; c < k; c++) {
                boolean stay = score[c] >= sw;
                back[t][c] = stay ? c : best;
                next[c] = (stay ? score[c] : sw) + Math.log(p[t][c] + 1e-9);
            }
            double[] tmp = score;
            score = next;
            next = tmp;
        }
        int[] path = new int[n];
        int best = 0;
        for (int c = 1; c < k; c++) if (score[c] > score[best]) best = c;
        path[n - 1] = best;
        for (int t = n - 1; t > 0; t--) path[t - 1] = back[t][path[t]];
        return path;
    }

    // ------------------------------------------------------------ input

    /** 44.1 kHz interleaved stereo → 22.05 kHz mono (half-band low-pass, then every other sample) */
    public static float[] toMono22k(float[] stereo, int frames) {
        int taps = 31, c = taps / 2;
        double[] h = new double[taps];
        double sum = 0;
        for (int i = 0; i < taps; i++) {
            int x = i - c;
            double sinc = x == 0 ? 0.5 : Math.sin(Math.PI * x / 2) / (Math.PI * x);
            double win = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (taps - 1));
            sum += h[i] = sinc * win;
        }
        for (int i = 0; i < taps; i++) h[i] /= sum;
        float[] out = new float[frames / 2];
        for (int o = 0; o < out.length; o++) {
            int center = 2 * o;
            double acc = 0;
            for (int i = 0; i < taps; i++) {
                int k = center + i - c;
                if (k < 0 || k >= frames) continue;
                acc += h[i] * 0.5 * (stereo[2 * k] + stereo[2 * k + 1]);
            }
            out[o] = (float) acc;
        }
        return out;
    }
}
