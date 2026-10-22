package app.stemkitmobile.core;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import java.util.zip.CRC32;

/**
 * "Cattura": song recognition by Shazam. The audio fingerprint is computed
 * here, as SongRec does (github.com/marin-m/SongRec, GPLv3: algorithm.rs and
 * signature_format.rs), and only the fingerprint is sent. Checked against
 * model-export/capture/shazam_sig.py.
 */
public final class ShazamSignature {
    public static final int RATE = 16000;
    private static final float[] HANN = new float[2048];

    static {
        for (int i = 0; i < 2048; i++) HANN[i] = (float) (0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 1) / 2049));
    }

    private static final class Peak {
        final int pass, magnitude, bin;

        Peak(int pass, int magnitude, int bin) {
            this.pass = pass;
            this.magnitude = magnitude;
            this.bin = bin;
        }
    }

    private ShazamSignature() {}

    /** the binary signature of mono 16 kHz samples (-1..1) */
    public static byte[] compute(float[] samples, int count) {
        short[] ring = new short[2048];
        int ri = 0;
        float[][] fftOut = new float[256][1025];
        int fi = 0;
        float[][] spread = new float[256][1025];
        int si = 0;
        int done = 0;
        List<List<Peak>> bands = new ArrayList<>();
        for (int b = 0; b < 4; b++) bands.add(new ArrayList<>());
        Fft fft = new Fft(2048);
        double[] re = new double[2048], im = new double[2048];
        for (int c = 0; c + 128 <= count; c += 128) {
            for (int k = 0; k < 128; k++) {
                long v = Math.round(samples[c + k] * 32767.0);
                ring[ri + k] = (short) Math.max(-32768, Math.min(32767, v));
            }
            ri = (ri + 128) & 2047;
            for (int k = 0; k < 2048; k++) {
                re[k] = ring[(k + ri) & 2047] * HANN[k];
                im[k] = 0;
            }
            fft.transform(re, im, false);
            float[] mag = fftOut[fi];
            for (int k = 0; k <= 1024; k++) mag[k] = (float) Math.max((re[k] * re[k] + im[k] * im[k]) / (1 << 17), 1e-10);
            fi = (fi + 1) & 255;

            // spreading: in frequency, then back in time
            float[] cur = spread[si];
            System.arraycopy(mag, 0, cur, 0, 1025);
            for (int p = 0; p <= 1022; p++) cur[p] = Math.max(cur[p], Math.max(cur[p + 1], cur[p + 2]));
            for (int back : new int[] {1, 3, 6}) {
                float[] former = spread[(si - back) & 255];
                for (int p = 0; p <= 1024; p++) former[p] = Math.max(former[p], cur[p]);
            }
            si = (si + 1) & 255;
            done++;
            if (done >= 46) recognizePeaks(fftOut[(fi - 46) & 255], spread, si, done - 46, bands);
        }
        return encode(bands, count);
    }

    private static final int[] NEAR = {-10, -7, -4, -3, 1, 2, 5, 8};
    private static final int[] OTHER = {-53, -45, 165, 172, 179, 186, 193, 200, 214, 221, 228, 235, 242, 249};

    private static void recognizePeaks(float[] f46, float[][] spread, int si, int pass, List<List<Peak>> bands) {
        float[] f49 = spread[(si - 49) & 255];
        for (int b = 10; b <= 1014; b++) {
            float v = f46[b];
            if (!(v >= 1f / 64 && v >= f49[b - 1])) continue;
            float m = 0;
            for (int o : NEAR) m = Math.max(m, f49[b + o]);
            if (!(v > m)) continue;
            float m2 = m;
            for (int o : OTHER) m2 = Math.max(m2, spread[(si + o) & 255][b - 1]);
            if (!(v > m2)) continue;
            float pm = (float) (Math.max(Math.log(v), 1.0 / 64) * 1477.3 + 6144);
            float pb = (float) (Math.max(Math.log(f46[b - 1]), 1.0 / 64) * 1477.3 + 6144);
            float pa = (float) (Math.max(Math.log(f46[b + 1]), 1.0 / 64) * 1477.3 + 6144);
            float v1 = pm * 2 - pb - pa;
            float v2 = (pa - pb) * 32 / v1;
            int corrected = (b * 64 + (int) v2) & 0xFFFF;
            int hz = (int) (corrected * (16000.0f / 2 / 1024 / 64));
            int band = hz >= 250 && hz <= 519 ? 0 : hz >= 520 && hz <= 1449 ? 1 : hz >= 1450 && hz <= 3499 ? 2 : hz >= 3500 && hz <= 5500 ? 3 : -1;
            if (band < 0) continue;
            bands.get(band).add(new Peak(pass, ((int) pm) & 0xFFFF, corrected));
        }
    }

    private static byte[] encode(List<List<Peak>> bands, int samples) {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        for (int bi = 0; bi < 4; bi++) {
            List<Peak> peaks = bands.get(bi);
            if (peaks.isEmpty()) continue;
            ByteBuffer buf = ByteBuffer.allocate(peaks.size() * 10 + 16).order(ByteOrder.LITTLE_ENDIAN);
            int last = 0;
            for (Peak p : peaks) {
                if (p.pass - last >= 255) {
                    buf.put((byte) 0xff).putInt(p.pass);
                    last = p.pass;
                }
                buf.put((byte) (p.pass - last)).putShort((short) p.magnitude).putShort((short) p.bin);
                last = p.pass;
            }
            int len = buf.position();
            ByteBuffer head = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN).putInt(0x60030040 + bi).putInt(len);
            body.write(head.array(), 0, 8);
            body.write(buf.array(), 0, len);
            for (int k = 0; k < (4 - len % 4) % 4; k++) body.write(0);
        }
        byte[] b = body.toByteArray();
        ByteBuffer out = ByteBuffer.allocate(56 + b.length).order(ByteOrder.LITTLE_ENDIAN);
        out.putInt(0xcafe2580).putInt(0).putInt(8 + b.length).putInt(0x94119c00).putInt(0).putInt(0).putInt(0).putInt(3 << 27)
            .putInt(0).putInt(0).putInt(samples + (int) (RATE * 0.24f)).putInt((15 << 19) + 0x40000)
            .putInt(0x40000000).putInt(8 + b.length).put(b);
        byte[] data = out.array();
        CRC32 crc = new CRC32();
        crc.update(data, 8, data.length - 8);
        ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN).putInt(4, (int) crc.getValue());
        return data;
    }

    /** asks Shazam: the raw answer (empty "matches" when nothing was recognised) */
    public static JSONObject recognize(byte[] signature, int samples) throws Exception {
        long ts = System.currentTimeMillis() & 0xFFFFFFFFL;
        JSONObject post = new JSONObject()
            .put("geolocation", new JSONObject().put("altitude", 300).put("latitude", 45).put("longitude", 9))
            .put("signature", new JSONObject().put("samplems", (int) (samples / (float) RATE * 1000)).put("timestamp", ts)
                .put("uri", "data:audio/vnd.shazam.sig;base64," + Base64.getEncoder().encodeToString(signature)))
            .put("timestamp", ts)
            .put("timezone", "Europe/Rome");
        String url = "https://amp.shazam.com/discovery/v5/it/IT/android/-/tag/" + UUID.randomUUID().toString().toUpperCase() + "/" + UUID.randomUUID()
            + "?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&video=v3";
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setConnectTimeout(15_000);
        c.setReadTimeout(20_000);
        c.setRequestProperty("Content-Type", "application/json");
        c.setRequestProperty("Content-Language", "it_IT");
        c.setRequestProperty("User-Agent", "Dalvik/2.1.0 (Linux; U; Android 14; Pixel 8 Build/AP2A.240805.005)");
        try (OutputStream o = c.getOutputStream()) {
            o.write(post.toString().getBytes(StandardCharsets.UTF_8));
        }
        int code = c.getResponseCode();
        if (code == 429) throw new IllegalStateException("troppe richieste: riprova tra un po'");
        if (code != 200) throw new IllegalStateException("Shazam ha risposto " + code);
        try (InputStream in = c.getInputStream()) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
            return new JSONObject(b.toString("UTF-8"));
        }
    }

    /** the useful part of an answer: {title, artist, image, album, year, genre, url} or null */
    public static JSONObject summary(JSONObject r) throws Exception {
        JSONObject t = r.optJSONObject("track");
        if (t == null) return null;
        JSONObject s = new JSONObject().put("title", t.optString("title")).put("artist", t.optString("subtitle"))
            .put("url", t.optString("url")).put("key", t.optString("key"));
        JSONObject images = t.optJSONObject("images");
        if (images != null) s.put("image", images.optString("coverarthq", images.optString("coverart")));
        JSONObject genres = t.optJSONObject("genres");
        if (genres != null) s.put("genre", genres.optString("primary"));
        org.json.JSONArray sections = t.optJSONArray("sections");
        for (int i = 0; sections != null && i < sections.length(); i++) {
            org.json.JSONArray meta = sections.getJSONObject(i).optJSONArray("metadata");
            for (int k = 0; meta != null && k < meta.length(); k++) {
                JSONObject m = meta.getJSONObject(k);
                String title = m.optString("title");
                if ("Album".equals(title)) s.put("album", m.optString("text"));
                if ("Released".equals(title) || "Pubblicato".equals(title) || "Uscita".equals(title)) s.put("year", m.optString("text"));
            }
        }
        org.json.JSONArray matches = r.optJSONArray("matches");
        if (matches != null && matches.length() > 0) s.put("offset", matches.getJSONObject(0).optDouble("offset"));
        return s;
    }
}
