package app.stemkitmobile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Spotify's catalogue (artists, albums, search) for the artist and album pages,
 * read like the web player does, with the anonymous token of the embed page:
 * no account needed. Only names, artwork and durations are used; the audio
 * comes from YouTube. Shared by the phone and the PC (pc-engine).
 */
final class SpotifyCatalog {
    private static final String UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
    private static final String ENDPOINT = "https://api-partner.spotify.com/pathfinder/v2/query";

    /* persisted-query ids of the web player; refreshed from its scripts if Spotify changes them */
    private static final Map<String, String> HASHES = new HashMap<>();
    static {
        HASHES.put("searchDesktop", "eef7cc54888d91bdd6802623477873caa3948ae173a0c34fd86827b267e94c03");
        HASHES.put("queryArtistOverview", "9f8134ef565e78621f1e1793555bd6633c5ac144ae0f89604ed3ae3f80b3c8e6");
        HASHES.put("getAlbum", "0b6ce3511e1b02e4a40fa95440f992acbe85080eb308af9194322d708fc1914f");
    }

    private static String token;
    private static long tokenAt;

    private SpotifyCatalog() {}

    // ------------------------------------------------------------ public API

    /** {artists: [{uri, name, image}], albums: [release], tracks: [track]} */
    static JSONObject search(String q) throws Exception {
        JSONObject vars = new JSONObject().put("searchTerm", q).put("offset", 0).put("limit", 10).put("numberOfTopResults", 5)
            .put("includeAudiobooks", false).put("includeArtistHasConcertsField", false).put("includePreReleases", false)
            .put("includeLocalConcertsField", false).put("includeAuthors", false);
        JSONObject s = query("searchDesktop", vars).getJSONObject("searchV2");
        JSONObject out = new JSONObject();
        JSONArray artists = new JSONArray();
        for (JSONObject a : items(s.optJSONObject("artists"))) {
            JSONObject d = a.optJSONObject("data");
            if (d != null && d.has("profile")) artists.put(artistRef(d));
        }
        JSONArray albums = new JSONArray();
        for (JSONObject a : items(s.optJSONObject("albumsV2"))) {
            JSONObject d = a.optJSONObject("data");
            if (d != null && "Album".equals(d.optString("__typename"))) albums.put(release(d));
        }
        JSONArray tracks = new JSONArray();
        for (JSONObject t : items(s.optJSONObject("tracksV2"))) {
            JSONObject item = t.optJSONObject("item");
            JSONObject d = item != null ? item.optJSONObject("data") : null;
            if (d != null && "Track".equals(d.optString("__typename"))) tracks.put(track(d, null));
        }
        return out.put("artists", artists).put("albums", albums).put("tracks", tracks);
    }

    /** Artist page: profile, popular tracks, discography, similar artists. */
    static JSONObject artist(String uri) throws Exception {
        JSONObject a = query("queryArtistOverview", new JSONObject().put("uri", uri).put("locale", "").put("includePrerelease", false))
            .getJSONObject("artistUnion");
        JSONObject p = a.optJSONObject("profile");
        JSONObject out = new JSONObject().put("uri", a.optString("uri", uri)).put("name", p != null ? p.optString("name") : "");
        JSONObject vis = a.optJSONObject("visuals");
        out.put("image", image(vis != null ? vis.optJSONObject("avatarImage") : null, 640));
        JSONObject header = a.optJSONObject("headerImage");
        out.put("header", header != null ? image(header.optJSONObject("data"), 2000) : "");
        JSONObject stats = a.optJSONObject("stats");
        if (stats != null) out.put("listeners", stats.optLong("monthlyListeners"));
        JSONObject bio = p != null ? p.optJSONObject("biography") : null;
        if (bio != null) out.put("bio", bio.optString("text").replaceAll("<[^>]+>", ""));
        JSONObject disc = a.optJSONObject("discography");
        JSONArray top = new JSONArray();
        if (disc != null) {
            for (JSONObject t : items(disc.optJSONObject("topTracks"))) {
                JSONObject d = t.optJSONObject("track");
                if (d != null) top.put(track(d, null));
            }
            out.put("albums", releases(disc.optJSONObject("albums")));
            out.put("singles", releases(disc.optJSONObject("singles")));
            out.put("compilations", releases(disc.optJSONObject("compilations")));
            JSONObject latest = disc.optJSONObject("latest");
            if (latest != null) out.put("latest", release(latest));
        }
        out.put("topTracks", top);
        JSONArray related = new JSONArray();
        JSONObject rc = a.optJSONObject("relatedContent");
        if (rc != null) {
            for (JSONObject r : items(rc.optJSONObject("relatedArtists"))) related.put(artistRef(r));
            JSONArray appears = new JSONArray();
            for (JSONObject r : items(rc.optJSONObject("appearsOn"))) {
                for (JSONObject rel : items(r.optJSONObject("releases"))) appears.put(release(rel));
            }
            out.put("appearsOn", appears);
        }
        out.put("related", related);
        return out;
    }

    /** Album page: its release info and the track list. */
    static JSONObject album(String uri) throws Exception {
        JSONObject a = query("getAlbum", new JSONObject().put("uri", uri).put("locale", "").put("offset", 0).put("limit", 300))
            .getJSONObject("albumUnion");
        JSONObject out = release(a);
        JSONArray tracks = new JSONArray();
        String cover = out.optString("image");
        for (JSONObject t : items(a.optJSONObject("tracksV2"))) {
            JSONObject d = t.optJSONObject("track");
            if (d != null) tracks.put(track(d, cover).put("album", out.optString("name")).put("albumUri", out.optString("uri")));
        }
        return out.put("tracks", tracks);
    }

    // ------------------------------------------------------------ normalisers

    private static JSONObject artistRef(JSONObject d) throws Exception {
        JSONObject p = d.optJSONObject("profile");
        JSONObject vis = d.optJSONObject("visuals");
        return new JSONObject().put("uri", d.optString("uri")).put("name", p != null ? p.optString("name") : "")
            .put("image", image(vis != null ? vis.optJSONObject("avatarImage") : null, 300));
    }

    private static JSONObject track(JSONObject d, String cover) throws Exception {
        JSONArray names = new JSONArray();
        JSONArray uris = new JSONArray();
        for (JSONObject a : items(d.optJSONObject("artists"))) {
            JSONObject p = a.optJSONObject("profile");
            names.put(p != null ? p.optString("name") : "");
            uris.put(a.optString("uri"));
        }
        JSONObject dur = d.optJSONObject("duration");
        if (dur == null) dur = d.optJSONObject("trackDuration");
        JSONObject album = d.optJSONObject("albumOfTrack");
        JSONObject o = new JSONObject().put("uri", d.optString("uri")).put("title", d.optString("name")).put("artists", names)
            .put("artistUris", uris).put("duration", Math.round((dur != null ? dur.optLong("totalMilliseconds") : 0) / 1000.0));
        if (album != null) {
            o.put("albumUri", album.optString("uri"));
            if (album.has("name")) o.put("album", album.optString("name"));
            o.put("image", image(album.optJSONObject("coverArt"), 300));
        } else if (cover != null) {
            o.put("image", cover);
        }
        if (d.has("playcount")) o.put("plays", d.optString("playcount"));
        return o;
    }

    private static JSONArray releases(JSONObject group) throws Exception {
        JSONArray out = new JSONArray();
        for (JSONObject g : items(group)) {
            JSONObject rels = g.optJSONObject("releases");
            if (rels == null) {
                out.put(release(g));
                continue;
            }
            for (JSONObject r : items(rels)) out.put(release(r));
        }
        return out;
    }

    private static JSONObject release(JSONObject r) throws Exception {
        JSONObject o = new JSONObject().put("uri", r.optString("uri")).put("name", r.optString("name"))
            .put("type", r.optString("type", "ALBUM")).put("image", image(r.optJSONObject("coverArt"), 300));
        JSONObject date = r.optJSONObject("date");
        if (date != null) {
            int year = date.optInt("year");
            String iso = date.optString("isoString");
            if (year == 0 && iso.length() >= 4) year = Integer.parseInt(iso.substring(0, 4));
            if (year > 0) o.put("year", year);
        }
        JSONArray names = new JSONArray();
        for (JSONObject a : items(r.optJSONObject("artists"))) {
            JSONObject p = a.optJSONObject("profile");
            if (p != null) names.put(p.optString("name"));
        }
        o.put("artists", names);
        JSONObject tracks = r.optJSONObject("tracks");
        if (tracks == null) tracks = r.optJSONObject("tracksV2");
        if (tracks != null && tracks.has("totalCount")) o.put("trackCount", tracks.optInt("totalCount"));
        return o;
    }

    /** the source closest to the wanted width */
    private static String image(JSONObject img, int want) {
        if (img == null) return "";
        JSONArray s = img.optJSONArray("sources");
        if (s == null || s.length() == 0) return "";
        JSONObject best = null;
        for (int i = 0; i < s.length(); i++) {
            JSONObject x = s.optJSONObject(i);
            if (x == null) continue;
            int w = x.optInt("width", x.optInt("maxWidth", 0));
            if (best == null) best = x;
            int bw = best.optInt("width", best.optInt("maxWidth", 0));
            if (w > 0 && (bw == 0 || Math.abs(w - want) < Math.abs(bw - want))) best = x;
        }
        return best != null ? best.optString("url") : "";
    }

    private static Iterable<JSONObject> items(JSONObject o) {
        java.util.List<JSONObject> out = new java.util.ArrayList<>();
        JSONArray a = o != null ? o.optJSONArray("items") : null;
        for (int i = 0; a != null && i < a.length(); i++) {
            JSONObject x = a.optJSONObject(i);
            if (x != null) out.add(x);
        }
        return out;
    }

    // ------------------------------------------------------------ transport

    private static synchronized String token(boolean fresh) throws Exception {
        if (!fresh && token != null && System.currentTimeMillis() - tokenAt < 40 * 60_000) return token;
        String html = get("https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M");
        Matcher m = Pattern.compile("\"accessToken\":\"([^\"]+)\"").matcher(html);
        if (!m.find()) throw new IOException("Spotify non risponde");
        token = m.group(1);
        tokenAt = System.currentTimeMillis();
        return token;
    }

    private static JSONObject query(String op, JSONObject vars) throws Exception {
        Exception last = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            try {
                return post(op, vars, token(attempt == 1));
            } catch (Exception e) {
                last = e;
                if (attempt == 1) refreshHashes();
            }
        }
        throw new IOException("Spotify: " + (last != null ? last.getMessage() : "errore"));
    }

    private static JSONObject post(String op, JSONObject vars, String tok) throws Exception {
        JSONObject body = new JSONObject().put("variables", vars).put("operationName", op)
            .put("extensions", new JSONObject().put("persistedQuery", new JSONObject().put("version", 1).put("sha256Hash", HASHES.get(op))));
        HttpURLConnection c = (HttpURLConnection) new URL(ENDPOINT).openConnection();
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setConnectTimeout(15_000);
        c.setReadTimeout(30_000);
        c.setRequestProperty("Authorization", "Bearer " + tok);
        c.setRequestProperty("Content-Type", "application/json");
        c.setRequestProperty("User-Agent", UA);
        c.setRequestProperty("Accept-Language", "it");
        try (OutputStream o = c.getOutputStream()) {
            o.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }
        if (c.getResponseCode() != 200) throw new IOException("risposta " + c.getResponseCode());
        JSONObject r = new JSONObject(read(c.getInputStream()));
        JSONObject data = r.optJSONObject("data");
        if (data == null) throw new IOException("risposta vuota");
        return data;
    }

    /** reads the current query ids out of the web player's scripts */
    private static synchronized void refreshHashes() {
        try {
            String page = get("https://open.spotify.com/search");
            Matcher js = Pattern.compile("https://open\\.spotifycdn\\.com/cdn/build/web-player/web-player\\.[0-9a-f]+\\.js").matcher(page);
            if (!js.find()) return;
            String main = get(js.group());
            scan(main);
            // search lives in its own chunk: name map + hash map of the webpack runtime
            Matcher id = Pattern.compile("(\\d+):\"xpui-routes-search\"").matcher(main);
            Matcher hm = Pattern.compile("\\+\"\\.\"\\+\\(\\{([^}]*)\\}\\)").matcher(main);
            if (id.find() && hm.find()) {
                Matcher h = Pattern.compile(id.group(1) + ":\"([0-9a-f]{8})\"").matcher(hm.group(1));
                if (h.find()) scan(get("https://open.spotifycdn.com/cdn/build/web-player/xpui-routes-search." + h.group(1) + ".js"));
            }
        } catch (Exception ignored) {
        }
    }

    private static void scan(String js) {
        Matcher m = Pattern.compile("\"(\\w+)\",\"query\",\"([0-9a-f]{64})\"").matcher(js);
        while (m.find()) if (HASHES.containsKey(m.group(1))) HASHES.put(m.group(1), m.group(2));
    }

    private static String get(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15_000);
        c.setReadTimeout(30_000);
        c.setRequestProperty("User-Agent", UA);
        return read(c.getInputStream());
    }

    private static String read(InputStream in) throws IOException {
        try (InputStream s = in) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = s.read(buf)) > 0) b.write(buf, 0, n);
            return b.toString(StandardCharsets.UTF_8.name());
        }
    }
}
