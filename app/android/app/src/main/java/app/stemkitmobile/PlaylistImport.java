package app.stemkitmobile;

import org.json.JSONArray;
import org.json.JSONObject;
import org.schabi.newpipe.extractor.Image;
import org.schabi.newpipe.extractor.InfoItem;
import org.schabi.newpipe.extractor.ListExtractor;
import org.schabi.newpipe.extractor.Page;
import org.schabi.newpipe.extractor.ServiceList;
import org.schabi.newpipe.extractor.StreamingService;
import org.schabi.newpipe.extractor.channel.ChannelInfo;
import org.schabi.newpipe.extractor.channel.tabs.ChannelTabInfo;
import org.schabi.newpipe.extractor.channel.tabs.ChannelTabs;
import org.schabi.newpipe.extractor.linkhandler.ListLinkHandler;
import org.schabi.newpipe.extractor.playlist.PlaylistInfo;
import org.schabi.newpipe.extractor.playlist.PlaylistInfoItem;
import org.schabi.newpipe.extractor.stream.StreamInfoItem;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * "Importa playlist" (Libreria → + Playlist): lists of songs from elsewhere, all in
 * the shape of YouTubeSource.spotifyList ({name, image, owner, tracks: [{title, artist, duration}]}):
 * - a SoundCloud playlist, and a SoundCloud profile's playlists and likes (NewPipe);
 * - a Spotify profile's public playlists;
 * - Spotify's own data export (the .zip, or its Playlist*.json / YourLibrary.json):
 *   every playlist, private ones too, and the liked songs.
 * The songs are then found on YouTube like any Spotify import (src/imports.tsx).
 */
final class PlaylistImport {
    private PlaylistImport() {}

    private static final int MAX = 3000;

    // ------------------------------------------------------------ SoundCloud

    /** a SoundCloud playlist ("set") or album */
    static JSONObject soundcloudList(String url) throws Exception {
        YouTubeSource.init();
        StreamingService sc = ServiceList.SoundCloud;
        PlaylistInfo info = PlaylistInfo.getInfo(sc, url.trim());
        List<StreamInfoItem> items = new ArrayList<>(info.getRelatedItems());
        Page next = info.getNextPage();
        while (Page.isValid(next) && items.size() < MAX) {
            ListExtractor.InfoItemsPage<StreamInfoItem> p = PlaylistInfo.getMoreItems(sc, url.trim(), next);
            items.addAll(p.getItems());
            next = p.getNextPage();
        }
        JSONObject r = new JSONObject().put("name", info.getName()).put("owner", info.getUploaderName()).put("tracks", tracks(items));
        String img = image(info.getThumbnails());
        if (img != null) r.put("image", img);
        return r;
    }

    /** SoundCloud tracks: "Artist - Title" names are split (the uploader is often a label) */
    private static JSONArray tracks(List<? extends InfoItem> items) throws Exception {
        JSONArray out = new JSONArray();
        for (InfoItem i : items) {
            if (!(i instanceof StreamInfoItem)) continue;
            StreamInfoItem s = (StreamInfoItem) i;
            String name = s.getName() == null ? "" : s.getName().trim();
            String artist = s.getUploaderName() == null ? "" : s.getUploaderName();
            int dash = name.indexOf(" - ");
            if (dash > 0) {
                artist = name.substring(0, dash).trim();
                name = name.substring(dash + 3).trim();
            }
            out.put(new JSONObject().put("title", name).put("artist", artist).put("duration", Math.max(0, s.getDuration())));
        }
        return out;
    }

    private static String image(List<Image> imgs) {
        if (imgs == null || imgs.isEmpty()) return null;
        return imgs.get(imgs.size() - 1).getUrl();
    }

    /**
     * A profile's playlists: {owner, playlists: [{name, url, count, image}], likes?: list}.
     * SoundCloud: its sets and albums, plus its likes (as a ready list). Spotify: its public playlists.
     */
    static JSONObject profile(String url) throws Exception {
        if (url.contains("soundcloud.com")) return soundcloudProfile(url.trim());
        if (url.contains("spotify.com/user/") || url.startsWith("spotify:user:")) return spotifyProfile(url.trim());
        throw new IOException("Incolla il link di un profilo Spotify o SoundCloud");
    }

    private static JSONObject soundcloudProfile(String url) throws Exception {
        YouTubeSource.init();
        StreamingService sc = ServiceList.SoundCloud;
        ChannelInfo ch = ChannelInfo.getInfo(sc, url);
        JSONArray lists = new JSONArray();
        JSONObject out = new JSONObject().put("owner", ch.getName());
        for (ListLinkHandler tab : ch.getTabs()) {
            List<String> f = tab.getContentFilters();
            boolean likes = f.contains(ChannelTabs.LIKES);
            if (!likes && !f.contains(ChannelTabs.PLAYLISTS) && !f.contains(ChannelTabs.ALBUMS)) continue;
            List<InfoItem> items = new ArrayList<>();
            try {
                ChannelTabInfo info = ChannelTabInfo.getInfo(sc, tab);
                items.addAll(info.getRelatedItems());
                Page next = info.getNextPage();
                while (Page.isValid(next) && items.size() < MAX) {
                    ListExtractor.InfoItemsPage<InfoItem> p = ChannelTabInfo.getMoreItems(sc, tab, next);
                    items.addAll(p.getItems());
                    next = p.getNextPage();
                }
            } catch (Exception e) {
                continue; // a tab that does not open (private likes…): the others still count
            }
            if (likes) {
                JSONArray t = tracks(items);
                if (t.length() > 0) out.put("likes", new JSONObject().put("name", "Mi piace di " + ch.getName()).put("owner", ch.getName()).put("tracks", t));
                continue;
            }
            for (InfoItem i : items) {
                if (!(i instanceof PlaylistInfoItem)) continue;
                PlaylistInfoItem p = (PlaylistInfoItem) i;
                JSONObject o = new JSONObject().put("name", p.getName()).put("url", p.getUrl()).put("count", p.getStreamCount());
                String img = image(p.getThumbnails());
                if (img != null) o.put("image", img);
                lists.put(o);
            }
        }
        return out.put("playlists", lists);
    }

    // ------------------------------------------------------------ Spotify

    /** a Spotify profile's public playlists (the ones it shows on its page) */
    private static JSONObject spotifyProfile(String url) throws Exception {
        Matcher m = Pattern.compile("user[/:]([^/?#:]+)").matcher(url);
        if (!m.find()) throw new IOException("Non è il link di un profilo Spotify");
        String user = m.group(1);
        JSONArray lists = new JSONArray();
        String owner = user;
        for (int offset = 0; offset < 1000; offset += 50) {
            JSONObject page = spotifyGet("https://api.spotify.com/v1/users/" + user + "/playlists?limit=50&offset=" + offset);
            JSONArray items = page.optJSONArray("items");
            if (items == null || items.length() == 0) break;
            for (int i = 0; i < items.length(); i++) {
                JSONObject p = items.optJSONObject(i);
                if (p == null) continue;
                JSONObject o = new JSONObject().put("name", p.optString("name")).put("url", p.optJSONObject("external_urls") != null ? p.getJSONObject("external_urls").optString("spotify") : "")
                    .put("count", p.optJSONObject("tracks") != null ? p.getJSONObject("tracks").optInt("total") : 0);
                JSONArray im = p.optJSONArray("images");
                if (im != null && im.length() > 0) o.put("image", im.getJSONObject(0).optString("url"));
                JSONObject ow = p.optJSONObject("owner");
                if (ow != null && ow.has("display_name")) owner = ow.optString("display_name", owner);
                lists.put(o);
            }
            if (page.isNull("next")) break;
        }
        return new JSONObject().put("owner", owner).put("playlists", lists);
    }

    private static JSONObject spotifyGet(String url) throws Exception {
        for (int attempt = 0; attempt < 2; attempt++) {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(15_000);
            c.setReadTimeout(30_000);
            c.setRequestProperty("Authorization", "Bearer " + SpotifyCatalog.token(attempt == 1));
            int code = c.getResponseCode();
            if (code == 200) return new JSONObject(YouTubeSource.readAll(c.getInputStream()));
            if (code == 404) throw new IOException("Profilo Spotify non trovato");
            if (attempt == 1 || code != 401) {
                throw new IOException("Spotify non mostra le playlist di questo profilo (" + code + "): usa \"Da file di Spotify\"");
            }
        }
        throw new IOException("Spotify non risponde");
    }

    /**
     * Spotify's data export ("Scarica i tuoi dati" in the account's privacy settings):
     * the .zip it mails you, or one of its files. {playlists: [list…], liked?: list}.
     */
    static JSONObject spotifyExport(File file) throws Exception {
        JSONArray playlists = new JSONArray();
        JSONObject out = new JSONObject();
        if (file.getName().toLowerCase().endsWith(".json")) {
            readExportJson(new String(java.nio.file.Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8), playlists, out);
        } else {
            try (ZipInputStream z = new ZipInputStream(new FileInputStream(file))) {
                ZipEntry e;
                while ((e = z.getNextEntry()) != null) {
                    String n = e.getName().replace('\\', '/');
                    String base = n.substring(n.lastIndexOf('/') + 1);
                    if (!base.endsWith(".json") || !(base.startsWith("Playlist") || base.startsWith("YourLibrary"))) continue;
                    readExportJson(readEntry(z), playlists, out);
                }
            }
        }
        if (playlists.length() == 0 && !out.has("liked")) {
            throw new IOException("Nel file non ci sono playlist di Spotify: serve lo zip dei \"Dati dell'account\" (o Playlist1.json)");
        }
        return out.put("playlists", playlists);
    }

    private static String readEntry(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[1 << 16];
        int n;
        while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
        return b.toString("UTF-8");
    }

    /** Playlist*.json: {playlists: [{name, items: [{track: {trackName, artistName}}]}]}; YourLibrary.json: {tracks: [{artist, track}]} */
    private static void readExportJson(String text, JSONArray playlists, JSONObject out) throws Exception {
        JSONObject j = new JSONObject(text);
        JSONArray pls = j.optJSONArray("playlists");
        for (int i = 0; pls != null && i < pls.length(); i++) {
            JSONObject p = pls.optJSONObject(i);
            if (p == null) continue;
            JSONArray items = p.optJSONArray("items");
            JSONArray t = new JSONArray();
            for (int k = 0; items != null && k < items.length(); k++) {
                JSONObject tr = items.optJSONObject(k) != null ? items.getJSONObject(k).optJSONObject("track") : null;
                if (tr == null || tr.optString("trackName").isEmpty()) continue; // episodes, local files
                t.put(new JSONObject().put("title", tr.optString("trackName")).put("artist", tr.optString("artistName")).put("duration", 0));
            }
            if (t.length() > 0) playlists.put(new JSONObject().put("name", p.optString("name", "Playlist Spotify")).put("owner", "Spotify").put("tracks", t));
        }
        JSONArray liked = j.optJSONArray("tracks");
        if (liked != null && liked.length() > 0 && j.has("tracks") && !j.has("playlists")) {
            JSONArray t = new JSONArray();
            for (int k = 0; k < liked.length(); k++) {
                JSONObject x = liked.optJSONObject(k);
                if (x == null || x.optString("track").isEmpty()) continue;
                t.put(new JSONObject().put("title", x.optString("track")).put("artist", x.optString("artist")).put("duration", 0));
            }
            if (t.length() > 0) out.put("liked", new JSONObject().put("name", "Brani che ti piacciono").put("owner", "Spotify").put("tracks", t));
        }
    }
}
