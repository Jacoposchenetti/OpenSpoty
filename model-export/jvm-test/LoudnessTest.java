import app.stemkitmobile.core.Loudness;

import java.io.BufferedInputStream;
import java.io.DataInputStream;
import java.io.FileInputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** Integrated loudness of a raw float32 stereo 44.1 kHz file (made with ffmpeg). */
public class LoudnessTest {
    public static void main(String[] args) throws Exception {
        Loudness l = new Loudness(44100);
        try (DataInputStream in = new DataInputStream(new BufferedInputStream(new FileInputStream(args[0]), 1 << 20))) {
            byte[] b = new byte[8 * 4096];
            float[] f = new float[2 * 4096];
            int n;
            while ((n = in.read(b)) > 0) {
                while (n % 8 != 0) {
                    int m = in.read(b, n, 8 - n % 8);
                    if (m < 0) break;
                    n += m;
                }
                ByteBuffer.wrap(b, 0, n).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().get(f, 0, n / 4);
                l.add(f, n / 8);
            }
        }
        System.out.printf("java: %.2f LUFS%n", l.integrated());
    }
}
