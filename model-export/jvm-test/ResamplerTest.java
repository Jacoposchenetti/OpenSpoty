import app.stemkitmobile.core.Resampler;

/** 1 kHz sine at 48 kHz -> 44.1 kHz: checks length, amplitude and frequency. */
public class ResamplerTest {
    public static void main(String[] args) {
        int src = 48000, dst = 44100, frames = src * 2;
        short[] in = new short[frames * 2];
        for (int i = 0; i < frames; i++) {
            short v = (short) Math.round(16000 * Math.sin(2 * Math.PI * 1000 * i / src));
            in[2 * i] = v;
            in[2 * i + 1] = (short) -v;
        }
        long t0 = System.nanoTime();
        short[] out = Resampler.resample(in, frames, src, dst);
        double ms = (System.nanoTime() - t0) / 1e6;
        int n = out.length / 2;
        double err = 0, peak = 0;
        for (int i = 1000; i < n - 1000; i++) {
            double expect = 16000 * Math.sin(2 * Math.PI * 1000 * i / dst);
            err = Math.max(err, Math.abs(out[2 * i] - expect));
            err = Math.max(err, Math.abs(out[2 * i + 1] + expect));
            peak = Math.max(peak, Math.abs(out[2 * i]));
        }
        System.out.printf("frames %d -> %d (expected %d), peak %.0f (expected 16000), max error %.1f LSB (%.1f dB below signal), %.0f ms for 2 s%n",
            frames, n, frames * dst / src, peak, err, 20 * Math.log10(16000 / err), ms);
    }
}
