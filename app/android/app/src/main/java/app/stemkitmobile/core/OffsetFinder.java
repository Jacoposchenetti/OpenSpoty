package app.stemkitmobile.core;

/**
 * How many frames the stems lag behind the original (codec priming delays
 * differ between formats), found by FFT cross-correlation of a few seconds of
 * the original against the sum of the stems.
 */
public final class OffsetFinder {
    private OffsetFinder() {}

    public static final class Result {
        /** stems[t + lag] lines up with original[t] */
        public final int lag;
        /** normalized correlation at that lag, 0..1 */
        public final double confidence;

        Result(int lag, double confidence) {
            this.lag = lag;
            this.confidence = confidence;
        }
    }

    /** @param a original (mono), @param b sum of stems (mono), same start time */
    public static Result find(float[] a, float[] b, int maxLag) {
        int n = Math.min(a.length, b.length);
        int size = Integer.highestOneBit(Math.max(2, 2 * n - 1));
        if (size < 2 * n) size <<= 1;
        Fft fft = new Fft(size);
        double[] ar = new double[size], ai = new double[size], br = new double[size], bi = new double[size];
        double ea = 0, eb = 0;
        for (int i = 0; i < n; i++) {
            ar[i] = a[i];
            br[i] = b[i];
            ea += (double) a[i] * a[i];
            eb += (double) b[i] * b[i];
        }
        fft.transform(ar, ai, false);
        fft.transform(br, bi, false);
        // conj(A) * B -> correlation r[lag] = sum a[t] b[t + lag]
        for (int k = 0; k < size; k++) {
            double re = ar[k] * br[k] + ai[k] * bi[k];
            double im = ar[k] * bi[k] - ai[k] * br[k];
            ar[k] = re;
            ai[k] = im;
        }
        fft.transform(ar, ai, true);
        int best = 0;
        double bestVal = Double.NEGATIVE_INFINITY;
        for (int lag = -maxLag; lag <= maxLag; lag++) {
            double v = ar[(lag + size) % size] / size;
            if (v > bestVal) {
                bestVal = v;
                best = lag;
            }
        }
        double norm = Math.sqrt(ea * eb);
        return new Result(best, norm > 0 ? Math.max(0, bestVal / norm) : 0);
    }
}
