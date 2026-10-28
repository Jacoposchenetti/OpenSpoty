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
        int m = meterOf(pdown, spect, beats);
        int[] meter = new int[beats.length], pos;
        if (m >= 9) {
            // a rare long meter (9, 11, 12) heard all song long: one meter, one place for the "one"
            pos = steadyPhases(pdown, novelty(spect, beats), m);
            Arrays.fill(meter, m);
        } else {
            // the usual: the meter section by section (a song may go 4/4, 7/4, 4/4)
            int[][] mp = sections(pdown, spect, beats);
            meter = mp[0];
            pos = mp[1];
        }
        if (progress != null) progress.at(1f);
        return new Result(beats, meter, pos);
    }

    private static final int[] SECTION_METERS = {3, 4, 5, 6, 7};
    private static final double[] SECTION_PRIOR = {-0.2, 0, -0.4, -0.6, -0.4};
    private static final double SECTION_CHANGE = 10, REP_WEIGHT = 0.6, NOVELTY_WEIGHT = 0.5;
    private static final int REP_WINDOW = 14;

    /**
     * The meter bar by bar: a Viterbi over the beats with states (meter m, place k in the bar) and,
     * for each beat, three clues: the network's "one" (on k = 0), which meter repeats best around
     * here (likeness to the beats m and 2m later, over 14 beats each side, compared across meters),
     * and how much the sound changes on a bar start. A meter changes only at a bar start, at a cost:
     * it takes several bars of agreeing clues. Checked in model-export/rhythm on songs that change
     * (Money: 7/4, 4/4, 7/4, 4/4) and on songs that don't.
     */
    static int[][] sections(double[] pdown, float[][] spect, double[] beats) {
        int n = beats.length, M = 128, NM = SECTION_METERS.length;
        int[] meterOut = new int[n], posOut = new int[n];
        if (n == 0) return new int[][] {meterOut, posOut};
        // each beat's sound (mean spectrum up to the next beat), as is and with its neighbourhood removed
        double[][] f = new double[n][M], g = new double[n][M];
        for (int i = 0; i < n; i++) {
            int a = Math.min(spect.length - 1, (int) (beats[i] * FPS));
            int b = Math.min(spect.length, Math.max(a + 1, i + 1 < n ? (int) (beats[i + 1] * FPS) : a + 25));
            for (int r = a; r < b; r++) for (int k = 0; k < M; k++) f[i][k] += spect[r][k];
            for (int k = 0; k < M; k++) f[i][k] /= (b - a);
        }
        for (int i = 0; i < n; i++) {
            int lo = Math.max(0, i - 16), hi = Math.min(n - 1, i + 16);
            double norm = 0;
            for (int k = 0; k < M; k++) {
                double mean = 0;
                for (int j = lo; j <= hi; j++) mean += f[j][k];
                g[i][k] = f[i][k] - mean / (hi - lo + 1);
                norm += g[i][k] * g[i][k];
            }
            norm = Math.sqrt(norm) + 1e-9;
            for (int k = 0; k < M; k++) g[i][k] /= norm;
        }
        // change of sound on each beat, scaled by its 95th percentile
        double[] nov = new double[n];
        for (int i = 1; i < n; i++) {
            double c = 0, na = 0, nb = 0;
            for (int k = 0; k < M; k++) {
                c += f[i][k] * f[i - 1][k];
                na += f[i][k] * f[i][k];
                nb += f[i - 1][k] * f[i - 1][k];
            }
            nov[i] = 1 - c / (Math.sqrt(na * nb) + 1e-9);
        }
        double[] ns = nov.clone();
        Arrays.sort(ns);
        double p95 = ns[(int) (0.95 * (n - 1))] + 1e-9;
        for (int i = 0; i < n; i++) nov[i] /= p95;
        // likeness to the beat L later
        double[][] sim = new double[25][n];
        for (int L = 1; L <= 24; L++) {
            for (int i = 0; i + L < n; i++) {
                double s = 0;
                for (int k = 0; k < M; k++) s += g[i][k] * g[i + L][k];
                sim[L][i] = s;
            }
        }
        // for each meter, the repetition around each beat; then how it compares to the other meters there
        double[][] z = new double[NM][n];
        for (int a = 0; a < NM; a++) {
            int m = SECTION_METERS[a], m2 = Math.min(24, 2 * m);
            double[] prefix = new double[n + 1];
            for (int i = 0; i < n; i++) prefix[i + 1] = prefix[i] + (sim[m][i] + sim[m2][i]) / 2;
            for (int i = 0; i < n; i++) {
                int lo = Math.max(0, i - REP_WINDOW), hi = Math.min(n - 1, i + REP_WINDOW);
                z[a][i] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
            }
        }
        for (int i = 0; i < n; i++) {
            double mean = 0, var = 0;
            for (int a = 0; a < NM; a++) mean += z[a][i];
            mean /= NM;
            for (int a = 0; a < NM; a++) var += (z[a][i] - mean) * (z[a][i] - mean);
            double sd = Math.sqrt(var / NM) + 1e-9;
            for (int a = 0; a < NM; a++) z[a][i] = (z[a][i] - mean) / sd;
        }
        // states: (meter a, place k)
        int S = 0;
        for (int m : SECTION_METERS) S += m;
        int[] sa = new int[S], sk = new int[S], last = new int[NM];
        for (int a = 0, j = 0; a < NM; a++) {
            for (int k = 0; k < SECTION_METERS[a]; k++, j++) {
                sa[j] = a;
                sk[j] = k;
            }
            last[a] = j - 1;
        }
        double eps = 1e-3;
        double[] score = new double[S], next = new double[S];
        int[][] back = new int[n][S];
        for (int i = 0; i < n; i++) {
            double p = Math.min(1 - eps, Math.max(eps, pdown[i]));
            double lp = Math.log(p), lq = Math.log(1 - p);
            for (int j = 0; j < S; j++) {
                int a = sa[j];
                double e = (sk[j] == 0 ? lp + NOVELTY_WEIGHT * nov[i] : lq) + REP_WEIGHT * z[a][i] + SECTION_PRIOR[a] * 0.05;
                if (i == 0) {
                    next[j] = e;
                    continue;
                }
                if (sk[j] > 0) {
                    next[j] = score[j - 1] + e;
                    back[i][j] = j - 1;
                } else {
                    double best = -1e18;
                    int arg = 0;
                    for (int b = 0; b < NM; b++) {
                        double v = score[last[b]] - (b == a ? 0 : SECTION_CHANGE);
                        if (v > best) {
                            best = v;
                            arg = last[b];
                        }
                    }
                    next[j] = best + e;
                    back[i][j] = arg;
                }
            }
            double[] t = score;
            score = next;
            next = t;
        }
        int j = 0;
        for (int q = 1; q < S; q++) if (score[q] > score[j]) j = q;
        for (int i = n - 1; i >= 0; i--) {
            meterOut[i] = SECTION_METERS[sa[j]];
            posOut[i] = sk[j];
            if (i > 0) j = back[i][j];
        }
        return new int[][] {meterOut, posOut};
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

    /** meters looked for: 2–7, 9, 11, 12 beats per bar */
    private static boolean fromRepetition; // set by meterOf: the meter came from the repetition clue
    private static final int[] METERS = {2, 3, 4, 5, 6, 7, 9, 11, 12};

    /**
     * The meter of the song from two clues. The network's "one"s: how much stronger they are every m
     * beats than elsewhere; it is sure of itself on 4/4 and 3/4 (contrast above 0.2) and then decides.
     * Otherwise (odd meters, which it rarely saw) the music's own repetition: how alike each beat is
     * to the one m and 2m beats later (what repeats every 5 beats is a bar of 5).
     */
    static int meterOf(double[] pdown, float[][] spect, double[] beats) {
        fromRepetition = false;
        double[] net = new double[13];
        double conf = 0;
        for (int m : METERS) {
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
            net[m] = best;
            conf = Math.max(conf, best);
        }
        if (conf >= 0.2) {
            double[] weight = new double[13];
            Arrays.fill(weight, 0.75);
            weight[2] = 0.85;
            weight[3] = 1.0;
            weight[4] = 1.06;
            weight[5] = 0.8;
            weight[6] = 0.85;
            weight[7] = 0.8;
            int pick = 4;
            for (int m : METERS) if (net[m] * weight[m] > net[pick] * weight[pick]) pick = m;
            return simplest(pick, net, 0.75);
        }
        fromRepetition = true;
        double[] rep = repetition(spect, beats);
        int pick = 4;
        for (int m : METERS) if (m > 2 && rep[m] > rep[pick]) pick = m;
        return simplest(pick, rep, 0.8);
    }

    /** a bar that is two of a shorter one (2 in 4, 6 in 3, 12 in 6 or 4…) counts as the shorter one unless clearly better */
    private static int simplest(int pick, double[] score, double share) {
        if (pick == 2 && score[4] > share * score[2]) return 4;
        for (int d : METERS) {
            if (d < 3 || d >= pick || pick % d != 0) continue;
            if (score[d] > share * score[pick]) return d == 2 ? 4 : d;
        }
        return pick;
    }

    /** for every m, how alike each beat's sound is to the beats m and 2m later (beat-averaged spectra, local mean removed) */
    private static double[] repetition(float[][] spect, double[] beats) {
        int n = beats.length - 1, M = 128;
        double[] out = new double[13];
        if (n < 30) return out;
        double[][] f = new double[n][M];
        for (int i = 0; i < n; i++) {
            int a = Math.min(spect.length - 1, (int) (beats[i] * FPS)), b = Math.min(spect.length, Math.max(a + 1, (int) (beats[i + 1] * FPS)));
            for (int r = a; r < b; r++) for (int k = 0; k < M; k++) f[i][k] += spect[r][k];
            for (int k = 0; k < M; k++) f[i][k] /= (b - a);
        }
        double[][] g = new double[n][M];
        for (int i = 0; i < n; i++) {
            int lo = Math.max(0, i - 16), hi = Math.min(n - 1, i + 16);
            double norm = 0;
            for (int k = 0; k < M; k++) {
                double mean = 0;
                for (int j = lo; j <= hi; j++) mean += f[j][k];
                g[i][k] = f[i][k] - mean / (hi - lo + 1);
                norm += g[i][k] * g[i][k];
            }
            norm = Math.sqrt(norm) + 1e-9;
            for (int k = 0; k < M; k++) g[i][k] /= norm;
        }
        double[] sim = new double[25];
        for (int L = 1; L <= 24; L++) {
            double s = 0;
            for (int i = 0; i + L < n; i++) for (int k = 0; k < M; k++) s += g[i][k] * g[i + L][k];
            sim[L] = s / Math.max(1, n - L);
        }
        for (int m : METERS) out[m] = (sim[m] + sim[Math.min(24, 2 * m)]) / 2;
        return out;
    }

    /** how much the sound changes on each beat (1 - likeness to the beat before) */
    private static double[] novelty(float[][] spect, double[] beats) {
        int n = beats.length;
        double[] out = new double[n];
        double[] prev = null;
        for (int i = 0; i < n; i++) {
            int a = Math.min(spect.length - 1, (int) (beats[i] * FPS));
            int b = Math.min(spect.length, Math.max(a + 1, i + 1 < n ? (int) (beats[i + 1] * FPS) : a + 10));
            double[] v = new double[128];
            double norm = 0;
            for (int r = a; r < b; r++) for (int k = 0; k < 128; k++) v[k] += spect[r][k];
            for (int k = 0; k < 128; k++) norm += v[k] * v[k];
            norm = Math.sqrt(norm) + 1e-9;
            for (int k = 0; k < 128; k++) v[k] /= norm;
            if (prev != null) {
                double c = 0;
                for (int k = 0; k < 128; k++) c += v[k] * prev[k];
                out[i] = 1 - c;
            }
            prev = v;
        }
        return out;
    }

    /** one place for the "one" all song long: the phase where "one"s and changes of sound are strongest */
    private static int[] steadyPhases(double[] pdown, double[] novelty, int m) {
        int n = pdown.length;
        double nmax = 1e-9;
        for (double x : novelty) nmax = Math.max(nmax, x);
        int best = 0;
        double top = -1;
        for (int ph = 0; ph < m; ph++) {
            double s = 0;
            int c = 0;
            for (int i = ph; i < n; i += m) {
                s += pdown[i] + novelty[i] / nmax;
                c++;
            }
            if (c > 0 && s / c > top) {
                top = s / c;
                best = ph;
            }
        }
        int[] pos = new int[n];
        for (int i = 0; i < n; i++) pos[i] = ((i - best) % m + m) % m;
        return pos;
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
        for (int i = 0; i < NFFT; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NFFT);
        double norm = Math.sqrt(NFFT); // torchaudio's normalized="frame_length": divided by sqrt(n_fft)
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
