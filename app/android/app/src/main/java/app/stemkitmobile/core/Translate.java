package app.stemkitmobile.core;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import org.json.JSONArray;

/**
 * Lines of a transcript in another language, through Google Translate's free
 * endpoint of its Chrome extension (no key; the other free one refuses Java).
 * One line per "q", a few thousand characters per request; one translation back per line.
 */
public final class Translate {
    private Translate() {}

    public static List<String> lines(List<String> in, String to) throws Exception {
        List<String> out = new ArrayList<>();
        List<String> batch = new ArrayList<>();
        int size = 0;
        for (String line : in) {
            String l = line.replace('\n', ' ').trim();
            if (size + l.length() > 1800 && !batch.isEmpty()) {
                out.addAll(request(batch, to));
                batch.clear();
                size = 0;
            }
            batch.add(l);
            size += l.length();
        }
        if (!batch.isEmpty()) out.addAll(request(batch, to));
        return out;
    }

    private static List<String> request(List<String> lines, String to) throws Exception {
        StringBuilder url = new StringBuilder("https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=")
            .append(URLEncoder.encode(to, "UTF-8"));
        for (String l : lines) url.append("&q=").append(URLEncoder.encode(l.isEmpty() ? " " : l, "UTF-8"));
        HttpURLConnection c = (HttpURLConnection) new URL(url.toString()).openConnection();
        c.setConnectTimeout(15_000);
        c.setReadTimeout(30_000);
        c.setRequestProperty("User-Agent", "Mozilla/5.0");
        try {
            if (c.getResponseCode() != 200) throw new IllegalStateException("traduzione non riuscita (" + c.getResponseCode() + ")");
            String body;
            try (InputStream s = c.getInputStream()) {
                java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[1 << 14];
                int n;
                while ((n = s.read(buf)) > 0) b.write(buf, 0, n);
                body = new String(b.toByteArray(), StandardCharsets.UTF_8);
            }
            JSONArray a = new JSONArray(body);
            List<String> res = new ArrayList<>();
            for (int i = 0; i < lines.size(); i++) {
                Object x = i < a.length() ? a.get(i) : "";
                res.add((x instanceof JSONArray ? ((JSONArray) x).optString(0) : String.valueOf(x)).trim());
            }
            return res;
        } finally {
            c.disconnect();
        }
    }
}
