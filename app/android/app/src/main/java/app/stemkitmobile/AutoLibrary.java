package app.stemkitmobile;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.support.v4.media.MediaBrowserCompat.MediaItem;
import android.support.v4.media.MediaDescriptionCompat;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import app.stemkitmobile.audio.Engine;

/**
 * The library as Android Auto (and other media browsers) sees it, read straight
 * from the app's files (library.json, playlists.json), so it works with the app
 * closed: Playlist, Brani che ti piacciono, Ascoltati di recente, Tutti i brani.
 * A playable item is "<list>|<songId>": playing it plays that list from there.
 * Songs become engine specs the way the app does it (src/playback.tsx nativeSpec).
 */
final class AutoLibrary {
    static final String ROOT = "root";
    static final String EMPTY = "empty";
    private static final String GEARHEAD = "com.google.android.projection.gearhead";
    private static final Pattern YT = Pattern.compile("^(?:yt|pc)-([\\w-]{11})$");
    private static final Pattern PARTS = Pattern.compile("^(.+?)\\s+[–-]\\s+(.+)$");
    private static final double TARGET_LUFS = -14;

    private final Context ctx;
    private final File base;

    AutoLibrary(Context ctx) {
        this.ctx = ctx;
        this.base = ctx.getFilesDir();
    }

    private JSONArray read(String name) {
        try {
            return new JSONArray(new String(Files.readAllBytes(new File(base, name).toPath()), StandardCharsets.UTF_8));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    private List<JSONObject> songs() {
        JSONArray a = read("library.json");
        List<JSONObject> out = new ArrayList<>();
        for (int i = 0; i < a.length(); i++) {
            JSONObject s = a.optJSONObject(i);
            if (s != null && playable(s)) out.add(s);
        }
        return out;
    }

    private static boolean playable(JSONObject s) {
        return original(s) != null || s.optJSONArray("stems") != null && s.optJSONArray("stems").length() > 0;
    }

    private static String original(JSONObject s) {
        String o = s.optString("original", "");
        if (!o.isEmpty() && !o.startsWith("bridge:")) return o;
        Matcher m = YT.matcher(s.optString("id"));
        return m.matches() ? "stream:" + m.group(1) : null;
    }

    // ------------------------------------------------------------ browsing

    List<MediaItem> children(String parent) {
        List<MediaItem> out = new ArrayList<>();
        if (ROOT.equals(parent)) {
            out.add(folder("pl", "Playlist"));
            out.add(folder("liked", "Brani che ti piacciono"));
            out.add(folder("recent", "Ascoltati di recente"));
            out.add(folder("all", "Tutti i brani"));
            return out;
        }
        if ("pl".equals(parent)) {
            JSONArray pls = read("playlists.json");
            List<JSONObject> list = new ArrayList<>();
            for (int i = 0; i < pls.length(); i++) if (pls.optJSONObject(i) != null) list.add(pls.optJSONObject(i));
            list.sort(Comparator.comparingDouble(p -> p.optDouble("pos", 1e12)));
            for (JSONObject p : list) {
                int n = p.optJSONArray("songIds") != null ? p.optJSONArray("songIds").length() : 0;
                out.add(new MediaItem(new MediaDescriptionCompat.Builder().setMediaId("pl:" + p.optString("id"))
                    .setTitle(p.optString("name")).setSubtitle(n + " brani").build(), MediaItem.FLAG_BROWSABLE));
            }
            return out;
        }
        for (JSONObject s : list(parent)) out.add(song(parent, s));
        return out;
    }

    /** the songs of a list, in the order the app shows them */
    List<JSONObject> list(String id) {
        List<JSONObject> all = songs();
        List<JSONObject> out = new ArrayList<>();
        if (id.startsWith("pl:")) {
            String pid = id.substring(3);
            JSONArray pls = read("playlists.json");
            for (int i = 0; i < pls.length(); i++) {
                JSONObject p = pls.optJSONObject(i);
                if (p == null || !pid.equals(p.optString("id"))) continue;
                JSONArray ids = p.optJSONArray("songIds");
                for (int k = 0; ids != null && k < ids.length(); k++) {
                    for (JSONObject s : all) {
                        if (s.optString("id").equals(ids.optString(k))) {
                            out.add(s);
                            break;
                        }
                    }
                }
            }
        } else if ("liked".equals(id)) {
            for (JSONObject s : all) if (s.optBoolean("liked")) out.add(s);
            out.sort((a, b) -> Double.compare(b.optDouble("likedAt", 0), a.optDouble("likedAt", 0)));
        } else if ("recent".equals(id)) {
            for (JSONObject s : all) if (s.optDouble("playedAt", 0) > 0) out.add(s);
            out.sort((a, b) -> Double.compare(b.optDouble("playedAt", 0), a.optDouble("playedAt", 0)));
            if (out.size() > 30) out = new ArrayList<>(out.subList(0, 30));
        } else if ("all".equals(id)) {
            out.addAll(all);
            out.sort((a, b) -> Double.compare(b.optDouble("addedAt", 0), a.optDouble("addedAt", 0)));
            if (out.size() > 500) out = new ArrayList<>(out.subList(0, 500));
        }
        return out;
    }

    static String listName(String id) {
        switch (id) {
            case "liked":
                return "Brani che ti piacciono";
            case "recent":
                return "Ascoltati di recente";
            case "all":
                return "Tutti i brani";
            default:
                return "Playlist";
        }
    }

    private MediaItem folder(String id, String title) {
        return new MediaItem(new MediaDescriptionCompat.Builder().setMediaId(id).setTitle(title).build(), MediaItem.FLAG_BROWSABLE);
    }

    private MediaItem song(String list, JSONObject s) {
        String[] np = nameParts(s.optString("title"));
        MediaDescriptionCompat.Builder b = new MediaDescriptionCompat.Builder()
            .setMediaId(list + "|" + s.optString("id")).setTitle(np[0]).setSubtitle(np[1]);
        Uri art = artUri(s);
        if (art != null) b.setIconUri(art);
        return new MediaItem(b.build(), MediaItem.FLAG_PLAYABLE);
    }

    /** the local cover through our FileProvider (Auto may read it), else the artwork address */
    private Uri artUri(JSONObject s) {
        String cover = s.optString("cover", "");
        if (!cover.isEmpty() && !cover.contains("..")) {
            File f = new File(base, cover);
            if (f.isFile()) {
                try {
                    Uri u = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", f);
                    ctx.grantUriPermission(GEARHEAD, u, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    return u;
                } catch (Exception ignored) {
                }
            }
        }
        String art = s.optString("art", "");
        if (art.startsWith("https://")) return Uri.parse(art);
        Matcher m = YT.matcher(s.optString("id"));
        return m.matches() ? Uri.parse("https://i.ytimg.com/vi/" + m.group(1) + "/hqdefault.jpg") : null;
    }

    static String[] nameParts(String title) {
        Matcher m = PARTS.matcher(title);
        return m.matches() ? new String[] {m.group(2).trim(), m.group(1).trim()} : new String[] {title, ""};
    }

    // ------------------------------------------------------------ playing

    /** what the engine needs for a song (as nativeSpec in src/playback.tsx) */
    Engine.Spec spec(JSONObject s) throws Exception {
        JSONObject d = new JSONObject();
        d.put("songId", s.optString("id"));
        d.put("title", s.optString("title"));
        String o = original(s);
        if (o != null) d.put("original", o);
        JSONObject stems = new JSONObject();
        JSONArray ids = s.optJSONArray("stems");
        JSONObject files = s.optJSONObject("files");
        for (int i = 0; ids != null && files != null && i < ids.length(); i++) {
            String f = files.optString(ids.optString(i), "");
            if (!f.isEmpty() && !f.startsWith("bridge:")) stems.put(ids.optString(i), f);
        }
        d.put("stems", stems);
        JSONObject mix = s.optJSONObject("mix");
        d.put("mix", mix != null ? mix : new JSONObject().put("muted", new JSONArray()).put("solo", new JSONArray()).put("vols", new JSONObject()).put("master", 1));
        if (s.has("stemOffset")) d.put("offset", s.opt("stemOffset"));
        d.put("duration", s.optDouble("duration", 0));
        if (s.opt("lufs") instanceof Number) d.put("gainDb", Math.max(-12, Math.min(6, TARGET_LUFS - s.optDouble("lufs"))));
        d.put("bpm", s.optDouble("bpm", 0));
        String[] np = nameParts(s.optString("title"));
        d.put("name", np[0]);
        d.put("artist", np[1]);
        if (s.has("cover")) d.put("cover", s.optString("cover"));
        if (s.has("art")) d.put("art", s.optString("art"));
        return StemPlayerPlugin.specOf(base, d);
    }

    /** a list played from `index`: the song, what comes after (the engine plays on alone) and before */
    static final class Start {
        Engine.Spec song, previous;
        List<Engine.Spec> next = new ArrayList<>();
        List<String> ids = new ArrayList<>();
        int index;
        String name;
    }

    Start start(String mediaId) throws Exception {
        int bar = mediaId.lastIndexOf('|');
        if (bar < 0) return null;
        String listId = mediaId.substring(0, bar), songId = mediaId.substring(bar + 1);
        List<JSONObject> l = list(listId);
        int i = 0;
        while (i < l.size() && !l.get(i).optString("id").equals(songId)) i++;
        if (i == l.size()) return null;
        return startAt(l, i, listName(listId));
    }

    Start startAt(List<JSONObject> l, int i, String name) throws Exception {
        Start st = new Start();
        st.index = i;
        st.name = name;
        for (JSONObject s : l) st.ids.add(s.optString("id"));
        st.song = spec(l.get(i));
        for (int k = i + 1; k < l.size() && k <= i + 30; k++) st.next.add(spec(l.get(k)));
        if (i > 0) st.previous = spec(l.get(i - 1));
        return st;
    }

    /** "Ok Google, metti … su OpenSpoty": the first song whose title has every word asked */
    Start search(String query) throws Exception {
        List<JSONObject> all = list("all");
        if (all.isEmpty()) return null;
        String q = fold(query == null ? "" : query);
        if (q.isEmpty()) {
            List<JSONObject> r = list("recent");
            return r.isEmpty() ? startAt(all, 0, listName("all")) : startAt(r, 0, listName("recent"));
        }
        String[] words = q.split(" ");
        for (int i = 0; i < all.size(); i++) {
            String t = fold(all.get(i).optString("title"));
            boolean ok = true;
            for (String w : words) ok &= t.contains(w);
            if (ok) return startAt(all, i, listName("all"));
        }
        return null;
    }

    private static String fold(String s) {
        return Normalizer.normalize(s, Normalizer.Form.NFD).replaceAll("\\p{M}", "").toLowerCase().replaceAll("[^a-z0-9]+", " ").trim();
    }

    static Bundle rootExtras() {
        Bundle b = new Bundle();
        // lists as rows, songs as a list (Android Auto content style)
        b.putInt("android.media.browse.CONTENT_STYLE_BROWSABLE_HINT", 1);
        b.putInt("android.media.browse.CONTENT_STYLE_PLAYABLE_HINT", 1);
        return b;
    }
}
