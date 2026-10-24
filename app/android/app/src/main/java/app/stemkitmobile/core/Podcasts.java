package app.stemkitmobile.core;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

import javax.xml.parsers.DocumentBuilderFactory;

import org.json.JSONArray;
import org.json.JSONObject;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

/**
 * Podcasts: found with Apple's public search (itunes.apple.com, no key), played
 * from their own RSS feed (the episodes' audio files, as the podcast publishes them).
 * Shows only on Spotify have no feed and can't be found here.
 */
public final class Podcasts {
    private Podcasts() {}

    /** [{feed, name, author, image, count}] */
    public static JSONArray search(String term) throws Exception {
        String url = "https://itunes.apple.com/search?media=podcast&country=IT&limit=10&term=" + URLEncoder.encode(term, "UTF-8");
        JSONObject r = new JSONObject(new String(get(url), StandardCharsets.UTF_8));
        JSONArray out = new JSONArray();
        JSONArray res = r.optJSONArray("results");
        for (int i = 0; res != null && i < res.length(); i++) {
            JSONObject x = res.optJSONObject(i);
            if (x == null || x.optString("feedUrl").isEmpty()) continue;
            out.put(new JSONObject()
                .put("feed", x.optString("feedUrl"))
                .put("name", x.optString("collectionName"))
                .put("author", x.optString("artistName"))
                .put("image", x.optString("artworkUrl600", x.optString("artworkUrl100")))
                .put("count", x.optInt("trackCount")));
        }
        return out;
    }

    /** {feed, name, author, image, description, episodes: [{guid, title, date, duration, url, description, image}]} newest first */
    public static JSONObject feed(String feedUrl) throws Exception {
        DocumentBuilderFactory f = DocumentBuilderFactory.newInstance();
        f.setNamespaceAware(true);
        f.setExpandEntityReferences(false);
        try {
            f.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        } catch (Exception ignored) {
            // not every parser knows the feature (Android's): entities stay unexpanded anyway
        }
        Document doc = f.newDocumentBuilder().parse(new ByteArrayInputStream(get(feedUrl)));
        Element ch = first(doc.getDocumentElement(), "channel");
        if (ch == null) throw new IllegalStateException("feed non valido");
        String image = itunesImage(ch);
        if (image.isEmpty()) {
            Element img = first(ch, "image");
            if (img != null) image = text(img, "url");
        }
        JSONObject out = new JSONObject()
            .put("feed", feedUrl)
            .put("name", text(ch, "title"))
            .put("author", itunes(ch, "author"))
            .put("image", image)
            .put("description", plain(text(ch, "description"), 600));
        JSONArray eps = new JSONArray();
        NodeList items = ch.getElementsByTagName("item");
        for (int i = 0; i < items.getLength(); i++) {
            Element it = (Element) items.item(i);
            Element enc = first(it, "enclosure");
            String url = enc != null ? enc.getAttribute("url") : "";
            if (url.isEmpty()) continue;
            String guid = text(it, "guid");
            String epImage = itunesImage(it);
            eps.put(new JSONObject()
                .put("guid", guid.isEmpty() ? url : guid)
                .put("title", text(it, "title"))
                .put("date", date(text(it, "pubDate")))
                .put("duration", seconds(itunes(it, "duration")))
                .put("url", url)
                .put("description", plain(text(it, "description"), 300))
                .put("image", epImage.isEmpty() ? image : epImage));
        }
        return out.put("episodes", eps);
    }

    // ------------------------------------------------------------ helpers

    private static byte[] get(String url) throws Exception {
        for (int hop = 0; hop < 6; hop++) {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(false); // followed by hand: also from http to https
            c.setConnectTimeout(15_000);
            c.setReadTimeout(30_000);
            c.setRequestProperty("User-Agent", "OpenSpoty/1 (podcast)");
            try {
                int code = c.getResponseCode();
                if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) {
                    url = new URL(new URL(url), c.getHeaderField("Location")).toString();
                    continue;
                }
                if (code != 200) throw new IllegalStateException("podcast non raggiungibile (" + code + ")");
                try (InputStream in = c.getInputStream()) {
                    java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
                    byte[] buf = new byte[1 << 16];
                    int n;
                    while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
                    return b.toByteArray();
                }
            } finally {
                c.disconnect();
            }
        }
        throw new IllegalStateException("troppi reindirizzamenti");
    }

    private static final String ITUNES = "http://www.itunes.com/dtds/podcast-1.0.dtd";

    /** a direct child by local name (any namespace except iTunes', unless asked) */
    private static Element first(Element parent, String name) {
        for (Node n = parent.getFirstChild(); n != null; n = n.getNextSibling()) {
            if (n instanceof Element && name.equals(local(n)) && !ITUNES.equals(n.getNamespaceURI())) return (Element) n;
        }
        return null;
    }

    private static String local(Node n) {
        return n.getLocalName() != null ? n.getLocalName() : n.getNodeName();
    }

    private static String text(Element parent, String name) {
        Element e = first(parent, name);
        return e != null ? e.getTextContent().trim() : "";
    }

    private static String itunes(Element parent, String name) {
        for (Node n = parent.getFirstChild(); n != null; n = n.getNextSibling()) {
            if (n instanceof Element && name.equals(local(n)) && ITUNES.equals(n.getNamespaceURI())) return n.getTextContent().trim();
        }
        return "";
    }

    private static String itunesImage(Element parent) {
        for (Node n = parent.getFirstChild(); n != null; n = n.getNextSibling()) {
            if (n instanceof Element && "image".equals(local(n)) && ITUNES.equals(n.getNamespaceURI())) return ((Element) n).getAttribute("href");
        }
        return "";
    }

    /** RFC 822 ("Tue, 21 Oct 2025 08:00:00 +0000") to epoch ms; 0 if unreadable */
    private static long date(String s) {
        String[] forms = {"EEE, d MMM yyyy HH:mm:ss Z", "EEE, d MMM yyyy HH:mm:ss zzz", "d MMM yyyy HH:mm:ss Z", "EEE, d MMM yyyy HH:mm Z"};
        for (String form : forms) {
            try {
                Date d = new SimpleDateFormat(form, Locale.ENGLISH).parse(s.trim());
                if (d != null) return d.getTime();
            } catch (Exception ignored) {
                // next form
            }
        }
        return 0;
    }

    /** "1:02:03", "62:03" or "3723" to seconds */
    private static int seconds(String s) {
        try {
            String[] p = s.trim().split(":");
            int t = 0;
            for (String x : p) t = t * 60 + (int) Double.parseDouble(x);
            return t;
        } catch (Exception e) {
            return 0;
        }
    }

    /** html out, spaces squeezed, cut at about n characters */
    private static String plain(String html, int n) {
        String t = html.replaceAll("(?s)<[^>]*>", " ").replace("&nbsp;", " ").replace("&amp;", "&").replace("&quot;", "\"")
            .replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">").replaceAll("\\s+", " ").trim();
        return t.length() > n ? t.substring(0, n).replaceAll("\\s+\\S*$", "") + "…" : t;
    }
}
