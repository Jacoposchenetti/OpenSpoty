package app.stemkitmobile.core;

import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;

/**
 * The beat of a song and its meter bar by bar (4/4, 3/4, 7/4…), also where it changes.
 * Beats: Beat This! (Foscarin, Schlüter, Widmer, ISMIR 2024, CPJKU, MIT), a network that
 * says for every 20 ms how likely a beat and a bar start ("one") are. Then the beats go on a
 * steady grid (see steady), one meter is chosen for the whole song (meterOf) and the "one" placed
 * on it (phases: a bar may restart early, for pickups). Reliable on 4/4 and 3/4; odd meters
 * (5/4, 7/4) only in part (the network rarely saw them).
 */
public final class Rhythm implements AutoCloseable {
    public static final int SR = 22050;
    private static final int NFFT = 1024, HOP = 441, BINS = 513, MELS = 128, CHUNK = 1500, BORDER = 6;
    public static final double FPS = 50.0;

    public static final String[] FILES = {"beat_this.onnx", "beat_mel.bin"};

    public interface Progress {
        void at(float fraction);
    }

    /** every beat (s), and for each its bar's meter and its place in the bar (0 = the "one") */
    public static final class Result {
        public final double[] beats;
        public final int[] meter, pos;

        Result(double[] beats, int[] meter, int[] pos) {
            this.beats = beats;
            this.meter = meter;
            this.pos = pos;
        }
    }

    private final OrtEnvironment env;
    private final OrtSession session;
    private final float[] mel; // [513][128]

    public Rhythm(File dir, int threads) throws Exception {
        env = OrtEnvironment.getEnvironment();
        OrtSession.SessionOptions o = new OrtSession.SessionOptions();
        o.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
        if (threads > 0) o.setIntraOpNumThreads(threads);
        session = env.createSession(new File(dir, FILES[0]).getAbsolutePath(), o);
        ByteBuffer b = ByteBuffer.wrap(Files.readAllBytes(new File(dir, FILES[1]).toPath())).order(ByteOrder.LITTLE_ENDIAN);
        mel = new float[BINS * MELS];
        b.asFloatBuffer().get(mel);
    }

    public Result analyse(float[] y, Progress progress) throws OrtException {
        float[][] spect = logMel(y);
        if (progress != null) progress.at(0.15f);
        float[][] out = predict(spect, progress);
        // the beat at a steady tempo (most songs are played to a click): a regular grid over the
        // beats found; a song really played freely (live, rubato) keeps the beats as they are
        double[] beats = steady(peaks(out[0]));
        double[] pdown = new double[beats.length];
        for (int i = 0; i < beats.length; i++) {
            int f = (int) Math.round(beats[i] * FPS);
            double best = 0;
            for (int j = Math.max(0, f - 2); j <= Math.min(out[1].length - 1, f + 2); j++) best = Math.max(best, 1 / (1 + Math.exp(-out[1][j])));
            pdown[i] = best;
        }
        // one meter for the whole song; only where the "one" falls may move (a pickup, a short bar)
        int m = meterOf(pdown);
        int[] pos = phases(pdown, m);
        int[] meter = new int[beats.length];
        Arrays.fill(meter, m);
        if (progress != null) progress.at(1f);
        return new Result(beats, meter, pos);
    }

    /**
     * The beats on a steady but supple grid: every beat is numbered (a missed one leaves its number
     * empty, an extra one is dropped), then each numbered beat is placed on a straight line fitted to
     * its ~8 neighbours each side (weighted, off-beat outliers left out). The step is regular, the
     * jitter is gone, and a song that slowly speeds up or slows down keeps its own pace.
     */
    static double[] steady(double[] b) {
        int n = b.length;
        if (n < 8) return b;
        double[] gaps = new double[n - 1];
        for (int i = 1; i < n; i++) gaps[i - 1] = b[i] - b[i - 1];
        // number the beats by the local step (median of the gaps around)
        int[] k = new int[n];
        for (int i = 1; i < n; i++) {
            double T = median(gaps, Math.max(0, i - 9), Math.min(n - 1, i + 8));
            double steps = (b[i] - b[i - 1]) / T;
            k[i] = k[i - 1] + (steps < 0.6 ? 0 : Math.max(1, (int) Math.rint(steps)));
        }
        int K = k[n - 1] + 1;
        boolean[] ok = new boolean[n];
        Arrays.fill(ok, true);
        for (int i = 1; i < n; i++) if (k[i] == k[i - 1]) ok[i] = false; // two beats for one place: the second goes
        final int W = 8;
        double[] grid = new double[K];
        for (int pass = 0; pass < 2; pass++) {
            int lo = 0;
            for (int g = 0; g < K; g++) {
                while (lo < n && k[lo] < g - W) lo++;
                double sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
                for (int j = lo; j < n && k[j] <= g + W; j++) {
                    if (!ok[j]) continue;
                    double d = Math.abs(k[j] - g) / (double) (W + 1);
                    double w = Math.pow(1 - d * d * d, 3);
                    double x = k[j] - g;
                    sw += w;
                    sx += w * x;
                    sy += w * b[j];
                    sxx += w * x * x;
                    sxy += w * x * b[j];
                }
                double den = sw * sxx - sx * sx;
                if (sw > 0 && Math.abs(den) > 1e-9) grid[g] = (sxx * sy - sx * sxy) / den; // the line at x = 0
                else grid[g] = g > 0 ? grid[g - 1] + gaps[Math.min(gaps.length - 1, g)] : b[0];
            }
            // beats far from their place (an off-beat taken for a beat) don't pull the next pass
            for (int j = 0; j < n; j++) if (ok[j] && Math.abs(b[j] - grid[k[j]]) > 0.06) ok[j] = false;
        }
        for (int g = 1; g < K; g++) if (grid[g] <= grid[g - 1]) grid[g] = grid[g - 1] + 0.05;
        if (grid[0] < 0) grid[0] = 0;
        return grid;
    }

    private static double median(double[] a, int from, int to) {
        double[] s = Arrays.copyOfRange(a, from, Math.max(from + 1, to));
        Arrays.sort(s);
        return s[s.length / 2];
    }

    /** the meter that best puts strong "one"s every m beats (4 and 3 preferred, 2 and 6 only if clearly better) */
    static int meterOf(double[] pdown) {
        double[] score = new double[8];
        for (int m = 2; m <= 7; m++) {
            double best = -1;
            for (int ph = 0; ph < m; ph++) {
                double on = 0, off = 0;
                int non = 0, noff = 0;
                for (int i = 0; i < pdown.length; i++) {
                    if ((i - ph) % m == 0) {
                        on += pdown[i];
                        non++;
                    } else {
                        off += pdown[i];
                        noff++;
                    }
                }
                if (non == 0 || noff == 0) continue;
                best = Math.max(best, on / non - off / noff);
            }
            score[m] = best;
        }
        double[] weight = {0, 0, 0.85, 1.0, 1.06, 0.8, 0.85, 0.8};
        int pick = 4;
        for (int m = 2; m <= 7; m++) if (score[m] * weight[m] > score[pick] * weight[pick]) pick = m;
        // a bar of 2 is half a bar of 4 (and 6 is two of 3): the longer one unless clearly worse
        if (pick == 2 && score[4] > 0.75 * score[2]) pick = 4;
        if (pick == 6 && score[3] > 0.8 * score[6]) pick = 3;
        return pick;
    }

    /** the place of each beat in its bar of m: Viterbi, a bar may restart early at a cost (pickups, a short bar) */
    static int[] phases(double[] pdown, int m) {
        int n = pdown.length;
        int[] pos = new int[n];
        if (n == 0) return pos;
        double eps = 1e-4, RESET = 6.0;
        double[] score = new double[m], next = new double[m];
        int[][] back = new int[n][m];
        for (int k = 0; k < m; k++) {
            double p = Math.min(1 - eps, Math.max(eps, pdown[0]));
            score[k] = Math.log(k == 0 ? p : 1 - p);
        }
        for (int i = 1; i < n; i++) {
            double p = Math.min(1 - eps, Math.max(eps, pdown[i]));
            for (int k = 0; k < m; k++) {
                int prev = (k + m - 1) % m;
                double v = score[prev];
                int arg = prev;
                if (k == 0) {
                    for (int q = 0; q < m - 1; q++) {
                        if (score[q] - RESET > v) {
                            v = score[q] - RESET;
                            arg = q;
                        }
                    }
                }
                next[k] = v + Math.log(k == 0 ? p : 1 - p);
                back[i][k] = arg;
            }
            double[] t = score;
            score = next;
            next = t;
        }
        int k = 0;
        for (int q = 1; q < m; q++) if (score[q] > score[k]) k = q;
        for (int i = n - 1; i >= 0; i--) {
            pos[i] = k;
            if (i > 0) k = back[i][k];
        }
        return pos;
    }

    // ------------------------------------------------------------ spectrogram

    private float[][] logMel(float[] y) {
        int pad = NFFT / 2, len = y.length + 2 * pad;
        float[] x = new float[len];
        System.arraycopy(y, 0, x, pad, y.length);
        for (int i = 0; i < pad && i + 1 < y.length; i++) { // reflect
            x[pad - 1 - i] = y[i + 1];
            x[pad + y.length + i] = y[Math.max(0, y.length - 2 - i)];
        }
        int n = 1 + (len - NFFT) / HOP;
        double[] win = new double[NFFT];
        double norm = 0;
        for (int i = 0; i < NFFT; i++) {
            win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NFFT);
            norm += win[i] * win[i];
        }
        norm = Math.sqrt(norm);
        Fft fft = new Fft(NFFT);
        double[] re = new double[NFFT], im = new double[NFFT], mag = new double[BINS];
        float[][] out = new float[n][MELS];
        for (int f = 0; f < n; f++) {
            int s = f * HOP;
            for (int i = 0; i < NFFT; i++) {
                re[i] = x[s + i] * win[i];
                im[i] = 0;
            }
            fft.transform(re, im, false);
            for (int k = 0; k < BINS; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / norm;
            for (int m = 0; m < MELS; m++) {
                double acc = 0;
                for (int k = 0; k < BINS; k++) acc += mag[k] * mel[k * MELS + m];
                out[f][m] = (float) Math.log1p(1000 * acc);
            }
        }
        return out;
    }

    // ------------------------------------------------------------ the network, in chunks

    private float[][] predict(float[][] spect, Progress progress) throws OrtException {
        int T = spect.length;
        List<Integer> starts = new ArrayList<>();
        for (int s = -BORDER; s < T - BORDER; s += CHUNK - 2 * BORDER) starts.add(s);
        if (T > CHUNK - 2 * BORDER) starts.set(starts.size() - 1, T - (CHUNK - BORDER));
        float[] beat = new float[T], down = new float[T];
        Arrays.fill(beat, -1000f);
        Arrays.fill(down, -1000f);
        int done = 0;
        for (int c = starts.size() - 1; c >= 0; c--) { // earlier chunks win (keep the first)
            int st = starts.get(c);
            int a = Math.max(st, 0), b = Math.min(st + CHUNK, T);
            int left = Math.max(0, -st), right = Math.max(0, Math.min(BORDER, st + CHUNK - T));
            int rows = T >= CHUNK ? CHUNK : left + (b - a) + right;
            float[] in = new float[rows * MELS];
            for (int r = a; r < b; r++) System.arraycopy(spect[r], 0, in, (left + r - a) * MELS, MELS);
            float[] pb, pd;
            try (OnnxTensor t = OnnxTensor.createTensor(env, FloatBuffer.wrap(in), new long[] {1, rows, MELS});
                 OrtSession.Result res = session.run(java.util.Collections.singletonMap("spect", t))) {
                pb = floats(res.get(0));
                pd = floats(res.get(1));
            }
            int lo = st + BORDER, hi = Math.min(st + CHUNK - BORDER, T);
            for (int i = lo; i < hi; i++) {
                int k = BORDER + (i - lo);
                if (i < 0 || k >= pb.length) continue;
                beat[i] = pb[k];
                down[i] = pd[k];
            }
            done++;
            if (progress != null) progress.at(0.15f + 0.8f * done / starts.size());
        }
        return new float[][] {beat, down};
    }

    private static float[] floats(ai.onnxruntime.OnnxValue v) {
        FloatBuffer b = ((OnnxTensor) v).getFloatBuffer();
        float[] out = new float[b.remaining()];
        b.get(out);
        return out;
    }

    /** beats: local maxima within ±3 frames above probability 0.5; neighbours become one */
    private static double[] peaks(float[] lg) {
        List<Double> out = new ArrayList<>();
        double sum = 0;
        int count = 0, last = -10;
        for (int i = 0; i < lg.length; i++) {
            if (lg[i] <= 0) continue;
            boolean max = true;
            for (int j = Math.max(0, i - 3); j <= Math.min(lg.length - 1, i + 3); j++) if (lg[j] > lg[i]) max = false;
            if (!max) continue;
            if (count > 0 && i - last > 1) {
                out.add(sum / count / FPS);
                sum = 0;
                count = 0;
            }
            sum += i;
            count++;
            last = i;
        }
        if (count > 0) out.add(sum / count / FPS);
        double[] a = new double[out.size()];
        for (int i = 0; i < a.length; i++) a[i] = out.get(i);
        return a;
    }

    @Override
    public void close() throws OrtException {
        session.close();
    }
}
