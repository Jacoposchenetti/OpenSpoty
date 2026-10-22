import app.stemkitmobile.core.Limiter;
import app.stemkitmobile.core.OffsetFinder;
import app.stemkitmobile.core.Resampler;
import app.stemkitmobile.core.StreamResampler;

import java.util.Random;

/** Desktop checks for the native playback engine's pure-Java parts. */
public class EngineCoreTest {
    static void check(boolean ok, String what) {
        System.out.println((ok ? "OK   " : "FAIL ") + what);
        if (!ok) failures++;
    }

    static int failures;

    public static void main(String[] args) {
        // ---- limiter: unity below threshold, never above it
        for (double amp : new double[] {0.25, 0.5, 0.85, 1.4, 2.5}) {
            int sr = 44100, n = sr * 2;
            float[] buf = new float[2 * n];
            for (int i = 0; i < n; i++) buf[2 * i] = buf[2 * i + 1] = (float) (amp * Math.sin(2 * Math.PI * 440 * i / sr));
            Limiter lim = new Limiter(sr, -1f, 2f, 120f);
            for (int off = 0; off < n; off += 1024) {
                int f = Math.min(1024, n - off);
                float[] block = new float[2 * f];
                System.arraycopy(buf, 2 * off, block, 0, 2 * f);
                lim.process(block, f);
                System.arraycopy(block, 0, buf, 2 * off, 2 * f);
            }
            double pk = 0;
            for (int i = n / 2; i < n; i++) pk = Math.max(pk, Math.abs(buf[2 * i]));
            double inDb = 20 * Math.log10(amp), outDb = 20 * Math.log10(pk);
            boolean ok = amp < 0.89 ? Math.abs(outDb - inDb) < 0.01 : outDb <= -0.99;
            check(ok, String.format("limiter %+.1f dB in -> %+.2f dB out", inDb, outDb));
        }

        // ---- streaming resampler == offline resampler (48k -> 44.1k)
        Random rnd = new Random(1);
        int frames = 48000 * 3;
        short[] pcm = new short[frames * 2];
        for (int i = 0; i < pcm.length; i++) pcm[i] = (short) (rnd.nextGaussian() * 6000);
        short[] offline = Resampler.resample(pcm, frames, 48000, 44100);
        StreamResampler sr = new StreamResampler(48000, 44100);
        sr.reset(0);
        float[] outAll = new float[offline.length + 64];
        int made = 0, fed = 0;
        float[] tmp = new float[2 * 700];
        while (made < offline.length / 2) {
            int want = Math.min(513, offline.length / 2 - made);
            int need = sr.inputNeeded(want);
            while (need > 0 && fed < frames) {
                int f = Math.min(Math.min(need, 700), frames - fed);
                float[] in = new float[2 * f];
                for (int i = 0; i < 2 * f; i++) in[i] = pcm[2 * fed + i] / 32768f;
                sr.feed(in, f);
                fed += f;
                need -= f;
            }
            float[] o = new float[2 * want];
            int got = sr.drain(o, want, fed >= frames);
            System.arraycopy(o, 0, outAll, 2 * made, 2 * got);
            made += got;
            if (got == 0) break;
        }
        double maxErr = 0;
        for (int i = 0; i < offline.length; i++) maxErr = Math.max(maxErr, Math.abs(outAll[i] * 32768 - offline[i]));
        check(made == offline.length / 2 && maxErr <= 1.0, "stream resampler vs offline: " + made + " frames, max diff " + String.format("%.2f", maxErr) + " LSB");

        // seek: restart in the middle and compare
        long at = 50000;
        StreamResampler s2 = new StreamResampler(48000, 44100);
        s2.reset(at);
        long inStart = s2.inputStartFor(at);
        int need = s2.inputNeeded(1000);
        float[] in = new float[2 * need];
        for (int i = 0; i < need; i++) {
            in[2 * i] = pcm[(int) (2 * (inStart + i))] / 32768f;
            in[2 * i + 1] = pcm[(int) (2 * (inStart + i) + 1)] / 32768f;
        }
        s2.feed(in, need);
        float[] o = new float[2000];
        int got = s2.drain(o, 1000, false);
        double e2 = 0;
        for (int i = 0; i < 2 * got; i++) e2 = Math.max(e2, Math.abs(o[i] * 32768 - offline[(int) (2 * at) + i]));
        check(got == 1000 && e2 <= 1.0, "stream resampler after seek: max diff " + String.format("%.2f", e2) + " LSB");

        // ---- offset finder: stems delayed by a codec priming of 1105 frames
        int n = 44100 * 3;
        float[] a = new float[n + 3000], b = new float[n];
        for (int i = 0; i < a.length; i++) a[i] = (float) rnd.nextGaussian();
        float[] orig = new float[n];
        System.arraycopy(a, 2000, orig, 0, n);
        for (int i = 0; i < n; i++) b[i] = a[2000 + i - 1105] * 0.8f + (float) rnd.nextGaussian() * 0.2f;
        OffsetFinder.Result r = OffsetFinder.find(orig, b, 4096);
        check(r.lag == 1105, "offset finder: lag " + r.lag + " (expected 1105), confidence " + String.format("%.2f", r.confidence));

        System.out.println(failures == 0 ? "ALL PASSED" : failures + " FAILED");
    }
}
