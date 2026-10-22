package app.stemkitmobile.core;

/**
 * Streaming version of {@link Resampler} (same windowed-sinc design) for
 * interleaved stereo floats, fed and drained in blocks of any size.
 */
public final class StreamResampler {
    private static final int PHASES = 512;
    private static final int HALF_TAPS = 24;

    private final double step; // input frames per output frame
    private final int half, taps;
    private final float[][] table;
    private float[] in = new float[2 * 8192]; // buffered input frames
    private int inFrames;
    private long inBase; // absolute index of in[0]
    private long outIndex; // next output frame

    public StreamResampler(int srcRate, int dstRate) {
        double ratio = (double) dstRate / srcRate;
        step = 1.0 / ratio;
        double cutoff = Math.min(1.0, ratio) * 0.97;
        half = (int) Math.ceil(HALF_TAPS / Math.min(1.0, ratio));
        taps = 2 * half;
        table = new float[PHASES + 1][taps];
        for (int p = 0; p <= PHASES; p++) {
            double frac = (double) p / PHASES;
            double sum = 0;
            for (int k = 0; k < taps; k++) {
                double x = (k - half + 1) - frac;
                double s = x == 0 ? 1.0 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
                double w = Math.abs(x) >= half ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * x / half) + 0.08 * Math.cos(2 * Math.PI * x / half);
                table[p][k] = (float) (s * w);
                sum += s * w;
            }
            for (int k = 0; k < taps; k++) table[p][k] /= (float) sum;
        }
    }

    /** Start producing output frame {@code outFrame}; the caller then feeds input from {@link #inputStartFor}. */
    public void reset(long outFrame) {
        outIndex = outFrame;
        inBase = inputStartFor(outFrame);
        inFrames = 0;
    }

    /** First input frame needed to produce output frame {@code outFrame}. */
    public long inputStartFor(long outFrame) {
        return Math.max(0, (long) Math.floor(outFrame * step) - half + 1);
    }

    /** Appends input frames (interleaved stereo). */
    public void feed(float[] src, int frames) {
        if ((inFrames + frames) * 2 > in.length) {
            float[] bigger = new float[Math.max(in.length * 2, (inFrames + frames) * 2)];
            System.arraycopy(in, 0, bigger, 0, inFrames * 2);
            in = bigger;
        }
        System.arraycopy(src, 0, in, inFrames * 2, frames * 2);
        inFrames += frames;
    }

    /** Input frames still wanted before {@link #drain} can make {@code frames} more output frames. */
    public int inputNeeded(int frames) {
        long last = (long) Math.floor((outIndex + frames - 1) * step) + half;
        long need = last + 1 - (inBase + inFrames);
        return (int) Math.max(0, need);
    }

    /** @param eof treat missing input past the end as silence */
    public int drain(float[] dst, int frames, boolean eof) {
        int made = 0;
        while (made < frames) {
            double t = outIndex * step;
            long center = (long) Math.floor(t);
            long first = center - half + 1;
            if (!eof && first + taps > inBase + inFrames) break;
            if (eof && center >= inBase + inFrames) break; // past the last input frame: done
            int p = (int) Math.round((t - center) * PHASES);
            float[] h = table[p];
            float l = 0, r = 0;
            for (int k = 0; k < taps; k++) {
                long i = first + k - inBase;
                if (i < 0 || i >= inFrames) continue;
                l += h[k] * in[2 * (int) i];
                r += h[k] * in[2 * (int) i + 1];
            }
            dst[2 * made] = l;
            dst[2 * made + 1] = r;
            made++;
            outIndex++;
        }
        // drop input no longer needed
        long keepFrom = Math.max(inBase, (long) Math.floor(outIndex * step) - half + 1);
        int drop = (int) Math.min(inFrames, keepFrom - inBase);
        if (drop > 0) {
            System.arraycopy(in, drop * 2, in, 0, (inFrames - drop) * 2);
            inFrames -= drop;
            inBase += drop;
        }
        return made;
    }
}
