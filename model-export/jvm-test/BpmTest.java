import app.stemkitmobile.core.Bpm;

import java.io.BufferedInputStream;
import java.io.FileInputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** BPM of synthetic click tracks, and of raw float32 stereo files given as arguments. */
public class BpmTest {
    static double synth(double bpm) {
        int sr = 44100, n = sr * 40;
        float[] buf = new float[2 * n];
        double period = 60.0 / bpm * sr;
        java.util.Random r = new java.util.Random(3);
        for (int beat = 0; beat * period < n; beat++) {
            int at = (int) (beat * period);
            for (int k = 0; k < 2000 && at + k < n; k++) {
                float v = (float) (Math.exp(-k / 300.0) * (beat % 2 == 0 ? Math.sin(2 * Math.PI * 60 * k / sr) : r.nextGaussian() * 0.5));
                buf[2 * (at + k)] += v;
                buf[2 * (at + k) + 1] += v;
            }
        }
        Bpm b = new Bpm(sr);
        b.add(buf, n);
        return b.bpm();
    }

    public static void main(String[] args) throws Exception {
        for (double t : new double[] {72, 96, 118, 128, 140, 174}) System.out.printf("synthetic %.0f BPM -> %.1f%n", t, synth(t));
        for (String f : args) {
            Bpm b = new Bpm(44100);
            try (BufferedInputStream in = new BufferedInputStream(new FileInputStream(f), 1 << 20)) {
                byte[] bytes = new byte[8 * 4096];
                float[] fl = new float[2 * 4096];
                int n;
                while ((n = in.readNBytes(bytes, 0, bytes.length)) > 0) {
                    ByteBuffer.wrap(bytes, 0, n).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().get(fl, 0, n / 4);
                    b.add(fl, n / 8);
                }
            }
            System.out.printf("%s -> %.1f BPM%n", f, b.bpm());
        }
    }
}
