package app.stemkitmobile.core;

/**
 * Look-ahead peak limiter for interleaved stereo floats.
 *
 * The signal is delayed by {@code lookahead} frames while a sliding maximum
 * over that window drives the gain, so the gain is already down when a peak
 * reaches the output. Below the threshold it is a pure delay (unity gain).
 */
public final class Limiter {
    private final int look;
    private final float thr;
    private final float attackCoef;
    private final float releaseCoef;
    private final float[] dl, dr; // delay line
    private final long[] dqIdx; // monotonic deque for the sliding max
    private final float[] dqVal;
    private int dqHead, dqTail; // indices into the circular deque
    private int pos;
    private long n;
    private float gain = 1f;

    public Limiter(int sampleRate, float thresholdDb, float lookaheadMs, float releaseMs) {
        look = Math.max(1, Math.round(sampleRate * lookaheadMs / 1000f));
        thr = (float) Math.pow(10, thresholdDb / 20.0);
        attackCoef = (float) Math.exp(-1.0 / Math.max(1, look / 4.0));
        releaseCoef = (float) Math.exp(-1.0 / (sampleRate * releaseMs / 1000.0));
        dl = new float[look];
        dr = new float[look];
        dqIdx = new long[look + 2];
        dqVal = new float[look + 2];
    }

    public int latencyFrames() {
        return look;
    }

    /** In place. */
    public void process(float[] buf, int frames) {
        final int cap = dqIdx.length;
        for (int i = 0; i < frames; i++) {
            float l = buf[2 * i], r = buf[2 * i + 1];
            float p = Math.max(Math.abs(l), Math.abs(r));
            // sliding max over the last `look` input samples
            while (dqHead != dqTail && dqVal[(dqTail - 1 + cap) % cap] <= p) dqTail = (dqTail - 1 + cap) % cap;
            dqIdx[dqTail] = n;
            dqVal[dqTail] = p;
            dqTail = (dqTail + 1) % cap;
            while (dqIdx[dqHead] <= n - look) dqHead = (dqHead + 1) % cap;
            float peak = dqVal[dqHead];
            float target = peak > thr ? thr / peak : 1f;
            gain = target < gain ? target + (gain - target) * attackCoef : target + (gain - target) * releaseCoef;
            // delayed sample out, new sample in
            float ol = dl[pos], or = dr[pos];
            dl[pos] = l;
            dr[pos] = r;
            pos = (pos + 1) % look;
            ol *= gain;
            or *= gain;
            // safety net for whatever the smoothed gain did not catch
            buf[2 * i] = ol > thr ? thr : (ol < -thr ? -thr : ol);
            buf[2 * i + 1] = or > thr ? thr : (or < -thr ? -thr : or);
            n++;
        }
    }

    public void reset() {
        java.util.Arrays.fill(dl, 0f);
        java.util.Arrays.fill(dr, 0f);
        dqHead = dqTail = 0;
        pos = 0;
        gain = 1f;
    }
}
