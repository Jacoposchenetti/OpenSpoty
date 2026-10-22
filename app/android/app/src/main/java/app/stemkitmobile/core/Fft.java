package app.stemkitmobile.core;

/** In-place iterative radix-2 complex FFT of a fixed power-of-two size. */
public final class Fft {
    private final int n;
    private final int[] rev;
    private final double[] cos;
    private final double[] sin;

    public Fft(int n) {
        if (Integer.bitCount(n) != 1) throw new IllegalArgumentException("n must be a power of two");
        this.n = n;
        rev = new int[n];
        int bits = Integer.numberOfTrailingZeros(n);
        for (int i = 0; i < n; i++) rev[i] = Integer.reverse(i) >>> (32 - bits);
        cos = new double[n / 2];
        sin = new double[n / 2];
        for (int i = 0; i < n / 2; i++) {
            cos[i] = Math.cos(2 * Math.PI * i / n);
            sin[i] = Math.sin(2 * Math.PI * i / n);
        }
    }

    public int size() {
        return n;
    }

    /** Forward transform (e^{-i...}) when inverse is false; unnormalized either way. */
    public void transform(double[] re, double[] im, boolean inverse) {
        for (int i = 0; i < n; i++) {
            int j = rev[i];
            if (j > i) {
                double t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }
        double sign = inverse ? 1 : -1;
        for (int len = 2; len <= n; len <<= 1) {
            int half = len >> 1;
            int step = n / len;
            for (int i = 0; i < n; i += len) {
                for (int k = 0; k < half; k++) {
                    double wr = cos[k * step];
                    double wi = sign * sin[k * step];
                    int a = i + k;
                    int b = a + half;
                    double xr = re[b] * wr - im[b] * wi;
                    double xi = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - xr;
                    im[b] = im[a] - xi;
                    re[a] += xr;
                    im[a] += xi;
                }
            }
        }
    }
}
