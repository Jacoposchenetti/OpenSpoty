package app.stemkitmobile.core;

/**
 * HT-Demucs spectrogram front/back end, outside the ONNX graph.
 *
 * Mirrors demucs HTDemucs._spec + _magnitude (cac) and _mask (cac) + _ispec,
 * i.e. torch.stft / torch.istft with n_fft 4096, hop 1024, periodic Hann,
 * normalized=True, center=True, reflect padding. Verified against numpy
 * (model-export/export_onnx.py np_spec / np_ispec), which matches torch.
 */
public final class Stft {
    public static final int NFFT = 4096;
    public static final int HOP = 1024;
    public static final int BINS = NFFT / 2; // 2048, Nyquist dropped as in _spec

    private final Fft fft = new Fft(NFFT);
    private final double[] win = new double[NFFT];
    private final double[] re = new double[NFFT];
    private final double[] im = new double[NFFT];
    private final double norm = Math.sqrt(NFFT);

    public Stft() {
        for (int i = 0; i < NFFT; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NFFT);
    }

    public static int frames(int length) {
        return (length + HOP - 1) / HOP;
    }

    /** numpy/torch 'reflect' index (edge sample not repeated). */
    private static int reflect(int i, int len) {
        if (len == 1) return 0;
        int period = 2 * (len - 1);
        i = Math.floorMod(i, period);
        return i < len ? i : period - i;
    }

    /**
     * @param x stereo segment, x[c][t]
     * @return complex-as-channels spectrogram, shape (C*2, BINS, T) row-major
     */
    public float[] spec(float[][] x) {
        int channels = x.length;
        int length = x[0].length;
        int le = frames(length);
        int pad = HOP / 2 * 3;
        int padRight = pad + le * HOP - length;
        int len1 = length + pad + padRight; // after demucs' own reflect pad
        float[] out = new float[channels * 2 * BINS * le];
        double[] padded = new double[len1 + NFFT];
        for (int c = 0; c < channels; c++) {
            float[] src = x[c];
            // first reflect pad (demucs pad1d), then torch.stft's center reflect pad
            double[] first = new double[len1];
            for (int i = 0; i < len1; i++) first[i] = src[reflect(i - pad, length)];
            for (int i = 0; i < len1 + NFFT; i++) padded[i] = first[reflect(i - NFFT / 2, len1)];
            for (int t = 0; t < le; t++) {
                int start = (t + 2) * HOP; // _spec keeps frames 2 .. 2+le
                for (int i = 0; i < NFFT; i++) {
                    re[i] = padded[start + i] * win[i];
                    im[i] = 0;
                }
                fft.transform(re, im, false);
                int baseRe = ((c * 2) * BINS) * le;
                int baseIm = ((c * 2 + 1) * BINS) * le;
                for (int f = 0; f < BINS; f++) {
                    out[baseRe + f * le + t] = (float) (re[f] / norm);
                    out[baseIm + f * le + t] = (float) (im[f] / norm);
                }
            }
        }
        return out;
    }

    /**
     * Inverse of {@link #spec} for one source.
     *
     * @param z      complex-as-channels spectrogram (C*2, BINS, T), read from offset
     * @param offset start of this source in z
     * @param channels audio channels (2)
     * @param le     frames T
     * @param length output samples per channel
     * @param out    out[c][0..length) receives the waveform (overwritten)
     */
    public void ispec(float[] z, int offset, int channels, int le, int length, float[][] out) {
        int nFrames = le + 4; // two zero frames on each side, as _ispec pads
        int full = NFFT + HOP * (nFrames - 1);
        int pad = HOP / 2 * 3;
        double[] wsum = new double[full];
        for (int t = 0; t < nFrames; t++) {
            for (int i = 0; i < NFFT; i++) wsum[t * HOP + i] += win[i] * win[i];
        }
        double[] y = new double[full];
        for (int c = 0; c < channels; c++) {
            java.util.Arrays.fill(y, 0);
            int baseRe = offset + ((c * 2) * BINS) * le;
            int baseIm = offset + ((c * 2 + 1) * BINS) * le;
            for (int t = 0; t < le; t++) {
                // Hermitian full spectrum; DC imag dropped and Nyquist = 0, like irfft
                re[0] = z[baseRe + t] * norm;
                im[0] = 0;
                for (int f = 1; f < BINS; f++) {
                    double r = z[baseRe + f * le + t] * norm;
                    double i = z[baseIm + f * le + t] * norm;
                    re[f] = r;
                    im[f] = i;
                    re[NFFT - f] = r;
                    im[NFFT - f] = -i;
                }
                re[BINS] = 0;
                im[BINS] = 0;
                fft.transform(re, im, true);
                int start = (t + 2) * HOP;
                for (int i = 0; i < NFFT; i++) y[start + i] += (re[i] / NFFT) * win[i];
            }
            float[] dst = out[c];
            for (int i = 0; i < length; i++) {
                int k = NFFT / 2 + pad + i; // center trim, then demucs' pad trim
                double w = wsum[k];
                dst[i] = (float) (y[k] / (w > 1e-11 ? w : 1.0));
            }
        }
    }
}
