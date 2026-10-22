package app.stemkitmobile.core;

/**
 * Tempo (BPM) estimate: onset-strength envelope (half-wave rectified
 * log-energy flux in 3 bands) autocorrelated over 60–200 BPM, with a
 * preference around 120 BPM to settle half/double-tempo ambiguity. Works best
 * on the drums stem. Feed stereo frames, then call {@link #bpm()}.
 */
public final class Bpm {
    private static final int HOP = 512, WIN = 1024;
    private final int rate;
    private final float[] frame = new float[WIN];
    private int fill;
    private final double[] prevBand = new double[3];
    private boolean first = true;
    private final java.util.ArrayList<Double> env = new java.util.ArrayList<>();
    private final Fft fft = new Fft(WIN);
    private final double[] re = new double[WIN], im = new double[WIN];

    public Bpm(int rate) {
        this.rate = rate;
    }

    public void add(float[] buf, int frames) {
        for (int i = 0; i < frames; i++) {
            frame[fill++] = 0.5f * (buf[2 * i] + buf[2 * i + 1]);
            if (fill == WIN) {
                analyse();
                System.arraycopy(frame, HOP, frame, 0, WIN - HOP);
                fill = WIN - HOP;
            }
        }
    }

    private void analyse() {
        for (int i = 0; i < WIN; i++) {
            double w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / WIN);
            re[i] = frame[i] * w;
            im[i] = 0;
        }
        fft.transform(re, im, false);
        // bands: lows (kick, bass) / mids (snare) / highs (hats)
        double[] band = new double[3];
        double binHz = (double) rate / WIN;
        for (int k = 1; k < WIN / 2; k++) {
            double f = k * binHz, p = re[k] * re[k] + im[k] * im[k];
            band[f < 200 ? 0 : f < 2500 ? 1 : 2] += p;
        }
        double flux = 0;
        for (int b = 0; b < 3; b++) {
            double l = Math.log10(1e-9 + band[b]);
            if (!first) flux += Math.max(0, l - prevBand[b]);
            prevBand[b] = l;
        }
        first = false;
        env.add(flux);
    }

    /** @return tempo in BPM (rounded to 0.5), or 0 if there is not enough signal */
    public double bpm() {
        int n = env.size();
        if (n < 200) return 0;
        double[] e = new double[n];
        double mean = 0;
        for (int i = 0; i < n; i++) mean += env.get(i);
        mean /= n;
        for (int i = 0; i < n; i++) e[i] = env.get(i) - mean;
        double fps = (double) rate / HOP;
        int minLag = (int) Math.floor(fps * 60 / 200), maxLag = (int) Math.ceil(fps * 60 / 60);
        double best = 0, bestScore = Double.NEGATIVE_INFINITY;
        double[] ac = new double[maxLag + 2];
        for (int lag = minLag; lag <= maxLag + 1 && lag < n; lag++) {
            double s = 0;
            for (int i = 0; i + lag < n; i++) s += e[i] * e[i + lag];
            ac[lag] = s / (n - lag);
        }
        for (int lag = minLag; lag <= maxLag && lag < n - 1; lag++) {
            // reinforce with the double-period peak (a beat repeats every 2 beats too)
            double s = ac[lag] + 0.5 * (2 * lag <= maxLag + 1 ? ac[Math.min(2 * lag, maxLag + 1)] : 0);
            double bpm = 60 * fps / lag;
            double prior = Math.exp(-0.5 * Math.pow(Math.log(bpm / 120) / Math.log(2) / 0.9, 2)); // log-normal around 120
            s *= prior;
            if (s > bestScore) {
                bestScore = s;
                // parabolic interpolation for sub-lag precision
                double y0 = ac[lag - 1], y1 = ac[lag], y2 = ac[lag + 1];
                double d = (y0 - 2 * y1 + y2) != 0 ? 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2) : 0;
                best = 60 * fps / (lag + Math.max(-0.5, Math.min(0.5, d)));
            }
        }
        return best > 0 ? Math.round(best * 2) / 2.0 : 0;
    }
}
