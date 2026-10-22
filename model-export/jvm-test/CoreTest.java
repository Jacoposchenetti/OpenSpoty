import app.stemkitmobile.core.OrtModel;
import app.stemkitmobile.core.Separator;
import app.stemkitmobile.core.Stft;

import java.io.DataInputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

/** Checks the Android separation code (run on the desktop JVM) against the numpy/torch reference. */
public class CoreTest {
    static float[] npy(String path, int[] shapeOut) throws IOException {
        try (DataInputStream in = new DataInputStream(new FileInputStream(path))) {
            byte[] magic = new byte[8];
            in.readFully(magic);
            int hlen = Short.toUnsignedInt(Short.reverseBytes(in.readShort()));
            byte[] h = new byte[hlen];
            in.readFully(h);
            String header = new String(h, StandardCharsets.US_ASCII);
            if (!header.contains("'<f4'") || header.contains("'fortran_order': True")) throw new IOException("unsupported npy " + header);
            String shape = header.substring(header.indexOf("(") + 1, header.indexOf(")"));
            String[] dims = shape.split(",");
            int n = 1, k = 0;
            for (String d : dims) {
                if (d.trim().isEmpty()) continue;
                int v = Integer.parseInt(d.trim());
                if (shapeOut != null) shapeOut[k++] = v;
                n *= v;
            }
            byte[] raw = in.readAllBytes();
            float[] out = new float[n];
            ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().get(out);
            return out;
        }
    }

    static void report(String what, float[] a, float[] b) {
        double maxDiff = 0, err = 0, sig = 0;
        for (int i = 0; i < a.length; i++) {
            double d = a[i] - b[i];
            maxDiff = Math.max(maxDiff, Math.abs(d));
            err += d * d;
            sig += (double) b[i] * b[i];
        }
        System.out.printf("%-34s max abs diff %.2e  SNR %.1f dB%n", what, maxDiff, 10 * Math.log10(sig / Math.max(err, 1e-30)));
    }

    public static void main(String[] args) throws Exception {
        String dir = args[0];
        String model = args[1];
        int seg = Separator.SEG;

        // 1. STFT of one segment vs numpy
        float[] mixFlat = npy(dir + "/htdemucs_6s_mix.npy", null);
        float[][] mix = new float[2][seg];
        for (int c = 0; c < 2; c++) System.arraycopy(mixFlat, c * seg, mix[c], 0, seg);
        long t0 = System.nanoTime();
        float[] spec = new Stft().spec(mix);
        System.out.printf("java STFT one segment: %.0f ms%n", (System.nanoTime() - t0) / 1e6);
        report("STFT vs numpy", spec, npy(dir + "/htdemucs_6s_spec.npy", null));

        // 2. whole clip through the Java separator vs the python reference
        int[] shp = new int[3];
        float[] clip = npy(dir + "/ref_clip_mix.npy", shp);
        int total = shp[1];
        float[] ref = npy(dir + "/ref_clip_out.npy", null); // (S, 2, total)
        try (OrtModel m = new OrtModel(model, 0)) {
            int S = m.sources();
            float[] ours = new float[S * 2 * total];
            int[] pos = {0};
            Separator.Source src = new Separator.Source() {
                public int length() { return total; }
                public void read(int from, int count, float[][] dst) {
                    for (int c = 0; c < 2; c++)
                        for (int i = 0; i < count; i++) {
                            int k = from + i;
                            dst[c][i] = k >= 0 && k < total ? clip[c * total + k] : 0f;
                        }
                }
            };
            t0 = System.nanoTime();
            Separator.separate(src, m, (data, count) -> {
                for (int s = 0; s < S; s++)
                    for (int c = 0; c < 2; c++)
                        System.arraycopy(data[s][c], 0, ours, (s * 2 + c) * total + pos[0], count);
                pos[0] += count;
            }, (done, n) -> {
                System.out.printf("  segment %d/%d%n", done, n);
                return true;
            });
            System.out.printf("java whole clip (%d samples): %.1f s, emitted %d%n", total, (System.nanoTime() - t0) / 1e9, pos[0]);
            report("whole clip vs python reference", ours, ref);
        }
    }
}
