package app.stemkitmobile;

import org.json.JSONArray;
import org.json.JSONObject;
import org.schabi.newpipe.extractor.Image;
import org.schabi.newpipe.extractor.InfoItem;
import org.schabi.newpipe.extractor.NewPipe;
import org.schabi.newpipe.extractor.ServiceList;
import org.schabi.newpipe.extractor.StreamingService;
import org.schabi.newpipe.extractor.downloader.Downloader;
import org.schabi.newpipe.extractor.downloader.Request;
import org.schabi.newpipe.extractor.downloader.Response;
import org.schabi.newpipe.extractor.localization.ContentCountry;
import org.schabi.newpipe.extractor.localization.Localization;
import org.schabi.newpipe.extractor.search.SearchInfo;
import org.schabi.newpipe.extractor.services.youtube.linkHandler.YoutubeSearchQueryHandlerFactory;
import org.schabi.newpipe.extractor.stream.AudioStream;
import org.schabi.newpipe.extractor.stream.DeliveryMethod;
import org.schabi.newpipe.extractor.stream.StreamInfo;
import org.schabi.newpipe.extractor.stream.StreamInfoItem;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * YouTube search and audio download on the phone, through NewPipe Extractor
 * (no PC needed). Checked on the desktop in model-export/newpipe-test.
 */
final class YouTubeSource {
    private static final String UA = "Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0";
    private static final Pattern VIDEO_ID = Pattern.compile("[?&]v=([\\w-]{11})");
    private static volatile boolean inited;

    private YouTubeSource() {}

    private static final class HttpDownloader extends Downloader {
        @Override
        public Response execute(Request req) throws IOException {
            HttpURLConnection c = (HttpURLConnection) new URL(req.url()).openConnection();
            c.setRequestMethod(req.httpMethod());
            c.setConnectTimeout(15_000);
            c.setReadTimeout(30_000);
            c.setRequestProperty("User-Agent", UA);
            for (Map.Entry<String, List<String>> h : req.headers().entrySet()) {
                for (String v : h.getValue()) c.addRequestProperty(h.getKey(), v);
            }
            byte[] body = req.dataToSend();
            if (body != null) {
                c.setDoOutput(true);
                try (OutputStream o = c.getOutputStream()) {
                    o.write(body);
                }
            }
            int code = c.getResponseCode();
            InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
            String text = in == null ? "" : readAll(in);
            return new Response(code, c.getResponseMessage(), c.getHeaderFields(), text, c.getURL().toString());
        }
    }

    private static String readAll(InputStream in) throws IOException {
        try (InputStream s = in) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = s.read(buf)) > 0) b.write(buf, 0, n);
            return b.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static void init() {
        if (inited) return;
        synchronized (YouTubeSource.class) {
            if (!inited) {
                NewPipe.init(new HttpDownloader(), new Localization("it", "IT"), new ContentCountry("IT"));
                inited = true;
            }
        }
    }

    static String videoId(String url) {
        Matcher m = VIDEO_ID.matcher(url);
        return m.find() ? m.group(1) : null;
    }

    private static List<InfoItem> search(StreamingService yt, String q, String filter) {
        try {
            return SearchInfo.getInfo(yt, yt.getSearchQHFactory().fromQuery(q, Collections.singletonList(filter), "")).getRelatedItems();
        } catch (Exception e) {
            return Collections.emptyList();
        }
    }

    /**
     * Songs first (YouTube Music: proper artist names, and it is not filtered on
     * words like "erotico"), then ordinary videos (live versions, covers...).
     */
    static JSONArray search(String query) throws Exception {
        init();
        StreamingService yt = ServiceList.YouTube;
        CompletableFuture<List<InfoItem>> songs = CompletableFuture.supplyAsync(() -> search(yt, query, YoutubeSearchQueryHandlerFactory.MUSIC_SONGS));
        CompletableFuture<List<InfoItem>> videos = CompletableFuture.supplyAsync(() -> search(yt, query, YoutubeSearchQueryHandlerFactory.VIDEOS));
        JSONArray out = new JSONArray();
        Set<String> seen = new HashSet<>();
        add(out, seen, songs.get(), "song", 8);
        add(out, seen, videos.get(), "video", 12);
        return out;
    }

    private static void add(JSONArray out, Set<String> seen, List<InfoItem> items, String kind, int max) throws Exception {
        int n = 0;
        for (InfoItem i : items) {
            if (n >= max) break;
            if (!(i instanceof StreamInfoItem)) continue;
            StreamInfoItem s = (StreamInfoItem) i;
            String id = videoId(s.getUrl());
            if (id == null || !seen.add(id)) continue;
            JSONObject o = new JSONObject();
            o.put("videoId", id);
            o.put("title", s.getName());
            String up = s.getUploaderName();
            o.put("channel", up == null ? "" : up.replaceFirst(" - Topic$", ""));
            if (s.getDuration() > 0) o.put("duration", s.getDuration());
            o.put("thumbnail", thumbnail(s.getThumbnails(), id));
            o.put("kind", kind);
            out.put(o);
            n++;
        }
    }

    private static String thumbnail(List<Image> images, String id) {
        Image best = null;
        for (Image im : images) {
            if (best == null || (im.getWidth() >= 120 && im.getWidth() <= 480 && im.getWidth() > best.getWidth())) best = im;
        }
        return best != null ? best.getUrl() : "https://i.ytimg.com/vi/" + id + "/mqdefault.jpg";
    }

    interface Progress {
        /** @return false to cancel */
        boolean update(float fraction);
    }

    static final class Download {
        final File file;
        final long durationSec;

        Download(File file, long durationSec) {
            this.file = file;
            this.durationSec = durationSec;
        }
    }

    /**
     * Downloads the best audio-only stream of a video, untouched (no re-encoding),
     * as dir/<baseName>.<webm|m4a>.
     */
    /** The best audio-only stream of a video: where it is, its format and size (-1 = unknown). */
    static final class Audio {
        final String url, suffix, mime;
        final long length, durationSec;

        Audio(String url, String suffix, String mime, long length, long durationSec) {
            this.url = url;
            this.suffix = suffix;
            this.mime = mime;
            this.length = length;
            this.durationSec = durationSec;
        }
    }

    static Audio bestAudio(String videoId) throws Exception {
        init();
        StreamInfo info = StreamInfo.getInfo(ServiceList.YouTube, "https://www.youtube.com/watch?v=" + videoId);
        List<AudioStream> candidates = new ArrayList<>();
        for (AudioStream a : info.getAudioStreams()) {
            if (a.isUrl() && a.getFormat() != null && a.getDeliveryMethod() == DeliveryMethod.PROGRESSIVE_HTTP) candidates.add(a);
        }
        if (candidates.isEmpty()) throw new IOException("Nessun audio scaricabile per questo video");
        AudioStream best = candidates.get(0);
        for (AudioStream a : candidates) if (a.getAverageBitrate() > best.getAverageBitrate()) best = a;
        long total = best.getItagItem() != null ? best.getItagItem().getContentLength() : -1;
        return new Audio(best.getContent(), best.getFormat().getSuffix(), best.getFormat().getMimeType(), total, info.getDuration());
    }

    /** One byte range of a stream (YouTube throttles long single requests: callers fetch ~2 MB at a time). */
    static HttpURLConnection openRange(String url, long from, long to) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15_000);
        c.setReadTimeout(30_000);
        c.setRequestProperty("User-Agent", UA);
        c.setRequestProperty("Range", "bytes=" + from + "-" + to);
        return c;
    }

    static Download download(String videoId, File dir, String baseName, Progress progress) throws Exception {
        Audio best = bestAudio(videoId);

        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File out = new File(dir, baseName + "." + best.suffix);
        File part = new File(dir, baseName + ".part");
        long total = best.length;
        final long chunk = 2L << 20; // YouTube throttles long single requests: fetch 2 MB ranges
        long done = 0;
        try (OutputStream o = new FileOutputStream(part)) {
            while (total <= 0 || done < total) {
                HttpURLConnection c = openRange(best.url, done, done + chunk - 1);
                int code = c.getResponseCode();
                if (code != 200 && code != 206) throw new IOException("YouTube ha risposto " + code);
                if (total <= 0) {
                    String cr = c.getHeaderField("Content-Range");
                    total = cr != null && cr.contains("/") ? Long.parseLong(cr.substring(cr.indexOf('/') + 1).trim()) : Long.MAX_VALUE;
                }
                long got = 0;
                try (InputStream in = c.getInputStream()) {
                    byte[] buf = new byte[1 << 16];
                    int r;
                    while ((r = in.read(buf)) > 0) {
                        o.write(buf, 0, r);
                        got += r;
                    }
                } finally {
                    c.disconnect();
                }
                done += got;
                if (got == 0 || code == 200) break; // 200 = server sent everything at once
                if (total != Long.MAX_VALUE && !progress.update((float) done / total)) {
                    throw new InterruptedException();
                }
            }
        } catch (Exception e) {
            //noinspection ResultOfMethodCallIgnored
            part.delete();
            throw e;
        }
        if (out.exists()) //noinspection ResultOfMethodCallIgnored
            out.delete();
        if (!part.renameTo(out)) throw new IOException("salvataggio fallito");
        return new Download(out, best.durationSec);
    }

    /**
     * Tracks of a public Spotify playlist or album, read from Spotify's embed
     * page (no account needed): {name, tracks: [{title, artist, duration}]}.
     */
    static JSONObject spotifyList(String url) throws Exception {
        Matcher m = Pattern.compile("(playlist|album)[/:]([A-Za-z0-9]{10,})").matcher(url);
        if (!m.find()) throw new IOException("Non è il link di una playlist o di un album Spotify");
        HttpURLConnection c = (HttpURLConnection) new URL("https://open.spotify.com/embed/" + m.group(1) + "/" + m.group(2)).openConnection();
        c.setRequestProperty("User-Agent", UA);
        c.setConnectTimeout(15_000);
        c.setReadTimeout(30_000);
        if (c.getResponseCode() != 200) throw new IOException("Spotify ha risposto " + c.getResponseCode() + " (la playlist è pubblica?)");
        String html = readAll(c.getInputStream());
        Matcher d = Pattern.compile("<script id=\"__NEXT_DATA__\" type=\"application/json\">(.*?)</script>", Pattern.DOTALL).matcher(html);
        if (!d.find()) throw new IOException("Formato della pagina Spotify cambiato");
        JSONObject entity = findWith(new JSONObject(d.group(1)), "trackList");
        if (entity == null) throw new IOException("Nessun brano trovato nella playlist");
        JSONArray list = entity.getJSONArray("trackList");
        JSONArray tracks = new JSONArray();
        for (int i = 0; i < list.length(); i++) {
            JSONObject t = list.getJSONObject(i);
            JSONObject o = new JSONObject();
            o.put("title", t.optString("title"));
            o.put("artist", t.optString("subtitle").replace(' ', ' '));
            o.put("duration", Math.round(t.optLong("duration", 0) / 1000.0));
            tracks.put(o);
        }
        // the embed page stops at 100 tracks: page through the rest like the web player does
        if ("playlist".equals(m.group(1))) {
            Matcher tok = Pattern.compile("\"accessToken\":\"([^\"]+)\"").matcher(html);
            if (tok.find()) {
                try {
                    JSONArray all = playlistTracks(m.group(2), tok.group(1));
                    if (all.length() > tracks.length()) tracks = all;
                } catch (Exception e) {
                    System.err.println("YouTubeSource: full playlist: " + e);
                }
            }
        }
        JSONObject r = new JSONObject();
        r.put("name", entity.optString("name", entity.optString("title", "Playlist Spotify")));
        r.put("tracks", tracks);
        return r;
    }

    /** persisted-query id of the web player's fetchPlaylist (refreshed from its script if Spotify changes it) */
    private static String playlistQueryHash = "21ea11a6ac75a5f3e01fd365d29c18e0a4a8b7dc09f89bbb5d73910190c6acaf";

    private static JSONArray playlistTracks(String id, String token) throws Exception {
        JSONArray out = new JSONArray();
        int total = Integer.MAX_VALUE;
        boolean refreshed = false;
        for (int offset = 0; offset < total; ) {
            JSONObject content;
            try {
                content = playlistPage(id, token, offset);
            } catch (IOException e) {
                if (refreshed) throw e;
                refreshed = true;
                playlistQueryHash = currentQueryHash(id);
                continue;
            }
            total = content.optInt("totalCount", 0);
            JSONArray items = content.optJSONArray("items");
            if (items == null || items.length() == 0) break;
            for (int i = 0; i < items.length(); i++) {
                JSONObject d = items.getJSONObject(i).optJSONObject("itemV2");
                d = d == null ? null : d.optJSONObject("data");
                if (d == null || !"Track".equals(d.optString("__typename"))) continue; // podcast episodes, removed tracks
                List<String> names = new ArrayList<>();
                JSONArray artists = d.optJSONObject("artists") != null ? d.getJSONObject("artists").optJSONArray("items") : null;
                for (int k = 0; artists != null && k < artists.length(); k++) {
                    JSONObject pr = artists.getJSONObject(k).optJSONObject("profile");
                    if (pr != null) names.add(pr.optString("name"));
                }
                JSONObject dur = d.optJSONObject("trackDuration");
                JSONObject o = new JSONObject();
                o.put("title", d.optString("name"));
                o.put("artist", String.join(", ", names));
                o.put("duration", Math.round((dur != null ? dur.optLong("totalMilliseconds", 0) : 0) / 1000.0));
                out.put(o);
            }
            offset += items.length();
        }
        return out;
    }

    private static JSONObject playlistPage(String id, String token, int offset) throws Exception {
        JSONObject vars = new JSONObject().put("uri", "spotify:playlist:" + id).put("offset", offset).put("limit", 100)
            .put("enableWatchFeedEntrypoint", false);
        JSONObject body = new JSONObject().put("variables", vars).put("operationName", "fetchPlaylist")
            .put("extensions", new JSONObject().put("persistedQuery", new JSONObject().put("version", 1).put("sha256Hash", playlistQueryHash)));
        HttpURLConnection c = (HttpURLConnection) new URL("https://api-partner.spotify.com/pathfinder/v2/query").openConnection();
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setRequestProperty("Content-Type", "application/json");
        c.setRequestProperty("User-Agent", UA);
        c.setConnectTimeout(15_000);
        c.setReadTimeout(30_000);
        try (OutputStream o = c.getOutputStream()) {
            o.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }
        if (c.getResponseCode() != 200) throw new IOException("pathfinder " + c.getResponseCode());
        JSONObject data = new JSONObject(readAll(c.getInputStream())).optJSONObject("data");
        JSONObject pl = data == null ? null : data.optJSONObject("playlistV2");
        JSONObject content = pl == null ? null : pl.optJSONObject("content");
        if (content == null) throw new IOException("pathfinder: risposta senza brani");
        return content;
    }

    /** reads the fetchPlaylist query id out of the current web player script */
    private static String currentQueryHash(String id) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL("https://open.spotify.com/playlist/" + id).openConnection();
        c.setRequestProperty("User-Agent", UA);
        String page = readAll(c.getInputStream());
        Matcher js = Pattern.compile("https://open\\.spotifycdn\\.com/cdn/build/web-player/web-player\\.[0-9a-f]+\\.js").matcher(page);
        if (!js.find()) throw new IOException("script del web player non trovato");
        c = (HttpURLConnection) new URL(js.group()).openConnection();
        c.setRequestProperty("User-Agent", UA);
        Matcher h = Pattern.compile("\"fetchPlaylist\",\"query\",\"([0-9a-f]{64})\"").matcher(readAll(c.getInputStream()));
        if (!h.find()) throw new IOException("query fetchPlaylist non trovata");
        return h.group(1);
    }

    private static JSONObject findWith(Object o, String key) {
        if (o instanceof JSONObject) {
            JSONObject j = (JSONObject) o;
            if (j.has(key) && j.opt(key) instanceof JSONArray) return j;
            for (java.util.Iterator<String> it = j.keys(); it.hasNext(); ) {
                JSONObject r = findWith(j.opt(it.next()), key);
                if (r != null) return r;
            }
        } else if (o instanceof JSONArray) {
            JSONArray a = (JSONArray) o;
            for (int i = 0; i < a.length(); i++) {
                JSONObject r = findWith(a.opt(i), key);
                if (r != null) return r;
            }
        }
        return null;
    }

    private static String norm(String s) {
        return java.text.Normalizer.normalize(s, java.text.Normalizer.Form.NFD).replaceAll("\\p{M}", "")
            .toLowerCase(java.util.Locale.ROOT).replaceAll("[^a-z0-9 ]", " ").replaceAll("\\s+", " ").trim();
    }

    /**
     * The YouTube Music song that best matches a Spotify track: same title, same
     * artist, and above all the same duration (so not a live or a remix).
     */
    static JSONObject matchSong(String title, String artist, long durationSec) throws Exception {
        init();
        StreamingService yt = ServiceList.YouTube;
        String firstArtist = artist.split(",")[0].trim();
        List<InfoItem> items = search(yt, firstArtist + " " + title, YoutubeSearchQueryHandlerFactory.MUSIC_SONGS);
        String nt = norm(title.replaceAll("\\(.*?\\)|\\[.*?]| - .*$", ""));
        String na = norm(firstArtist);
        JSONObject best = null;
        double bestScore = -1e9;
        int rank = 0;
        for (InfoItem i : items) {
            if (!(i instanceof StreamInfoItem) || rank >= 10) continue;
            StreamInfoItem s = (StreamInfoItem) i;
            String id = videoId(s.getUrl());
            if (id == null) continue;
            String st = norm(s.getName()), sa = norm(s.getUploaderName() == null ? "" : s.getUploaderName());
            double score = -rank * 2.0;
            if (st.contains(nt) || nt.contains(st)) score += 30;
            if (sa.contains(na) || na.contains(sa)) score += 25;
            if (durationSec > 0 && s.getDuration() > 0) {
                long diff = Math.abs(s.getDuration() - durationSec);
                score += diff <= 3 ? 40 : diff <= 8 ? 20 : diff <= 20 ? 0 : -30;
            }
            for (String bad : new String[] {"live", "remix", "karaoke", "cover", "instrumental", "acoustic", "sped up", "slowed"}) {
                if (st.contains(bad) && !nt.contains(bad)) score -= 25;
            }
            if (score > bestScore) {
                bestScore = score;
                best = new JSONObject();
                best.put("videoId", id);
                best.put("title", s.getName());
                best.put("channel", s.getUploaderName() == null ? "" : s.getUploaderName().replaceFirst(" - Topic$", ""));
                best.put("duration", s.getDuration());
                best.put("score", score);
            }
            rank++;
        }
        if (best == null) throw new IOException("Nessuna corrispondenza su YouTube");
        return best;
    }

    /** Spotify link -> "artist title" to search (Spotify audio is DRM-protected). */
    static String spotifyQuery(String url) throws Exception {
        String title = "";
        HttpURLConnection c = (HttpURLConnection) new URL("https://open.spotify.com/oembed?url=" + java.net.URLEncoder.encode(url, "UTF-8")).openConnection();
        c.setRequestProperty("User-Agent", UA);
        if (c.getResponseCode() == 200) title = new JSONObject(readAll(c.getInputStream())).optString("title", "");
        String artist = "";
        try {
            HttpURLConnection p = (HttpURLConnection) new URL(url).openConnection();
            p.setRequestProperty("User-Agent", UA);
            String html = readAll(p.getInputStream());
            Matcher m = Pattern.compile("<meta property=\"og:description\" content=\"([^\"]+)\"").matcher(html);
            if (m.find()) artist = m.group(1).split("·")[0].trim();
        } catch (Exception ignored) {
        }
        String q = (artist + " " + title).trim();
        if (q.isEmpty()) throw new IOException("Non riesco a leggere il titolo dal link Spotify");
        return q;
    }
}
