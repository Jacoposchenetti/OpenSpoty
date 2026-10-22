package app.stemkitmobile.core;

/**
 * Integrated loudness (LUFS) per ITU-R BS.1770-4 / EBU R128: K-weighting
 * (high shelf + high pass), 400 ms blocks with 75% overlap, absolute gate at
 * -70 LUFS and relative gate at -10 LU. Feed stereo frames in any block size.
 */
public final class Loudness {
    private final int rate;
    private final Biquad[] shelf = new Biquad[2], hp = new Biquad[2];
    private final int step; // 100 ms
    private final double[] stepPower = new double[4]; // last four 100 ms sub-blocks
    private int stepFill, stepCount;
    private double acc;
    private final java.util.ArrayList<Double> blocks = new java.util.ArrayList<>();

    private static final class Biquad {
        final double b0, b1, b2, a1, a2;
        double x1, x2, y1, y2;

        Biquad(double b0, double b1, double b2, double a1, double a2) {
            this.b0 = b0;
            this.b1 = b1;
            this.b2 = b2;
            this.a1 = a1;
            this.a2 = a2;
        }

        double run(double x) {
            double y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            x2 = x1;
            x1 = x;
            y2 = y1;
            y1 = y;
            return y;
        }
    }

    public Loudness(int rate) {
        this.rate = rate;
        step = rate / 10;
        for (int c = 0; c < 2; c++) {
            // pre-filter: high shelf, f0 1681.97 Hz, +3.99984 dB, Q 0.7071752
            double f0 = 1681.974450955533, g = 3.999843853973347, q = 0.7071752369554196;
            double k = Math.tan(Math.PI * f0 / rate);
            double vh = Math.pow(10, g / 20), vb = Math.pow(vh, 0.4996667741545416);
            double a0 = 1 + k / q + k * k;
            shelf[c] = new Biquad((vh + vb * k / q + k * k) / a0, 2 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0,
                2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0);
            // RLB high pass, f0 38.135 Hz, Q 0.5003270
            f0 = 38.13547087602444;
            q = 0.5003270373238773;
            k = Math.tan(Math.PI * f0 / rate);
            a0 = 1 + k / q + k * k;
            hp[c] = new Biquad(1, -2, 1, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0);
        }
    }

    /** Interleaved stereo frames. */
    public void add(float[] buf, int frames) {
        for (int i = 0; i < frames; i++) {
            double l = hp[0].run(shelf[0].run(buf[2 * i]));
            double r = hp[1].run(shelf[1].run(buf[2 * i + 1]));
            acc += l * l + r * r;
            if (++stepFill == step) {
                stepPower[stepCount % 4] = acc / step;
                stepCount++;
                acc = 0;
                stepFill = 0;
                if (stepCount >= 4) {
                    double z = (stepPower[0] + stepPower[1] + stepPower[2] + stepPower[3]) / 4;
                    blocks.add(z);
                }
            }
        }
    }

    private static double lufs(double meanSquare) {
        return -0.691 + 10 * Math.log10(meanSquare);
    }

    /** @return integrated loudness in LUFS, or NaN for silence */
    public double integrated() {
        double sum = 0;
        int n = 0;
        for (double z : blocks) {
            if (z > 0 && lufs(z) > -70) {
                sum += z;
                n++;
            }
        }
        if (n == 0) return Double.NaN;
        double rel = lufs(sum / n) - 10;
        sum = 0;
        n = 0;
        for (double z : blocks) {
            if (z > 0 && lufs(z) > -70 && lufs(z) > rel) {
                sum += z;
                n++;
            }
        }
        return n == 0 ? Double.NaN : lufs(sum / n);
    }
}
