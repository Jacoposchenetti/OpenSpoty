package app.stemkitmobile.core;

/** Windowed-sinc sample-rate converter for interleaved 16-bit stereo. */
public final class Resampler {
    private static final int PHASES = 512;
    private static final int HALF_TAPS = 24;

    private Resampler() {}

    public static short[] resample(short[] in, int frames, int srcRate, int dstRate) {
        if (srcRate == dstRate) return in;
        double ratio = (double) dstRate / srcRate;
        double cutoff = Math.min(1.0, ratio) * 0.97; // anti-alias when going down
        int half = (int) Math.ceil(HALF_TAPS / Math.min(1.0, ratio));
        int taps = 2 * half;
        // table[p][k]: filter weight for fractional phase p/PHASES and tap k
        float[][] table = new float[PHASES + 1][taps];
        for (int p = 0; p <= PHASES; p++) {
            double frac = (double) p / PHASES;
            double sum = 0;
            for (int k = 0; k < taps; k++) {
                double x = (k - half + 1) - frac;
                double s = x == 0 ? 1.0 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
                double w = 0.42 + 0.5 * Math.cos(Math.PI * x / half) + 0.08 * Math.cos(2 * Math.PI * x / half); // Blackman
                if (Math.abs(x) >= half) w = 0;
                table[p][k] = (float) (s * w);
                sum += s * w;
            }
            for (int k = 0; k < taps; k++) table[p][k] /= (float) sum; // unity DC gain
        }
        int outFrames = (int) Math.floor(frames * ratio);
        short[] out = new short[outFrames * 2];
        double step = 1.0 / ratio;
        for (int n = 0; n < outFrames; n++) {
            double t = n * step;
            int center = (int) Math.floor(t);
            int p = (int) Math.round((t - center) * PHASES);
            float[] h = table[p];
            float l = 0, r = 0;
            int first = center - half + 1;
            for (int k = 0; k < taps; k++) {
                int i = first + k;
                if (i < 0 || i >= frames) continue;
                l += h[k] * in[2 * i];
                r += h[k] * in[2 * i + 1];
            }
            out[2 * n] = clamp(l);
            out[2 * n + 1] = clamp(r);
        }
        return out;
    }

    private static short clamp(float v) {
        int x = Math.round(v);
        return (short) (x > 32767 ? 32767 : Math.max(x, -32768));
    }
}
