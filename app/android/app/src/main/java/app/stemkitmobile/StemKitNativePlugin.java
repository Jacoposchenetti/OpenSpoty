package app.stemkitmobile;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.net.URLConnection;
import java.nio.charset.StandardCharsets;
import java.security.cert.X509Certificate;
import javax.net.ssl.HttpsURLConnection;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Native side of src/lib/native.ts. */
@CapacitorPlugin(
    name = "StemKitNative",
    permissions = {
        @Permission(strings = {Manifest.permission.POST_NOTIFICATIONS}, alias = "notifications"),
        @Permission(strings = {Manifest.permission.RECORD_AUDIO}, alias = "microphone")
    }
)
public class StemKitNativePlugin extends Plugin {
    private final ExecutorService io = Executors.newCachedThreadPool();

    @PluginMethod
    public void setLanguage(PluginCall call) {
        String language = call.getString("language", "it");
        getContext().getSharedPreferences("openspoty", Activity.MODE_PRIVATE).edit()
            .putString("language", "en".equals(language) ? "en" : "it").apply();
        call.resolve();
    }

    @PluginMethod
    public void setBridgeTrust(PluginCall call) {
        String fingerprint = call.getString("fingerprint", "").toLowerCase(java.util.Locale.ROOT);
        if (!fingerprint.matches("[0-9a-f]{64}")) {
            call.reject("Impronta SHA-256 non valida");
            return;
        }
        getContext().getSharedPreferences("openspoty", Activity.MODE_PRIVATE).edit()
            .putString("bridgeFingerprint", fingerprint).apply();
        call.resolve();
    }

    private HttpURLConnection bridgeConnection(String url, String fingerprint) throws Exception {
        URLConnection raw = new URL(url).openConnection();
        if (fingerprint == null || fingerprint.isEmpty()) return (HttpURLConnection) raw;
        if (!(raw instanceof HttpsURLConnection)) throw new SecurityException("Il Bridge deve usare HTTPS");
        HttpsURLConnection secure = (HttpsURLConnection) raw;
        secure.setSSLSocketFactory(BridgeTlsPin.context(fingerprint).getSocketFactory());
        secure.setHostnameVerifier((host, session) -> {
            try {
                java.security.cert.Certificate[] chain = session.getPeerCertificates();
                return chain.length > 0 && chain[0] instanceof X509Certificate
                    && BridgeTlsPin.matches((X509Certificate) chain[0], fingerprint);
            } catch (Exception e) {
                return false;
            }
        });
        return secure;
    }

    @Override
    public void load() {
        SeparationService.listener = e -> notifyListeners("separation", toJS(e));
    }

    private static JSObject toJS(JSONObject o) {
        try {
            return JSObject.fromJSONObject(o);
        } catch (Exception e) {
            return new JSObject();
        }
    }

    // ---------------------------------------------------------- file picker

    @PluginMethod
    public void pickAudio(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("audio/*");
        i.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {"audio/*", "video/mp4", "video/webm"});
        startActivityForResult(call, i, "onPicked");
    }

    @ActivityCallback
    private void onPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("Annullato");
            return;
        }
        Uri uri = result.getData().getData();
        io.execute(() -> {
            try {
                String name = displayName(uri);
                // copy now: the grant on the content URI may not outlive this screen
                File dir = new File(getContext().getCacheDir(), "picked");
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
                File dst = new File(dir, System.currentTimeMillis() + "-" + name.replaceAll("[^\\w.\\- ]", "_"));
                try (InputStream in = getContext().getContentResolver().openInputStream(uri); OutputStream out = new FileOutputStream(dst)) {
                    if (in == null) throw new IllegalStateException("file non leggibile");
                    byte[] buf = new byte[1 << 16];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
                JSObject r = new JSObject();
                r.put("uri", dst.getAbsolutePath());
                r.put("name", name);
                r.put("size", dst.length());
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Non riesco a leggere il file: " + e.getMessage());
            }
        });
    }

    private String displayName(Uri uri) {
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null && !n.isEmpty()) return n;
            }
        } catch (Exception ignored) {
        }
        String last = uri.getLastPathSegment();
        return last != null ? last : "canzone.mp3";
    }

    // ---------------------------------------------------------- PC bridge transfers

    private void transfer(String id, double pct) {
        JSObject e = new JSObject();
        e.put("id", id);
        e.put("pct", pct);
        notifyListeners("transfer", e);
    }

    @PluginMethod
    public void upload(PluginCall call) {
        String id = call.getString("id", "");
        String path = call.getString("uri");
        String url = call.getString("url");
        String pin = call.getString("pin", "");
        String fingerprint = call.getString("fingerprint", "");
        String filename = call.getString("filename", "canzone.mp3");
        io.execute(() -> {
            HttpURLConnection c = null;
            try {
                File f = new File(path);
                long size = f.length();
                c = bridgeConnection(url, fingerprint);
                c.setRequestMethod("POST");
                c.setDoOutput(true);
                c.setConnectTimeout(10_000);
                c.setReadTimeout(600_000);
                c.setFixedLengthStreamingMode(size);
                c.setRequestProperty("X-StemKit-Pin", pin);
                c.setRequestProperty("X-Filename", URLEncoder.encode(filename, "UTF-8").replace("+", "%20"));
                c.setRequestProperty("Content-Type", "application/octet-stream");
                try (InputStream in = new FileInputStream(f); OutputStream out = c.getOutputStream()) {
                    byte[] buf = new byte[1 << 16];
                    long sent = 0, lastPct = -1;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        sent += n;
                        long pct = size > 0 ? sent * 100 / size : 0;
                        if (pct != lastPct) {
                            lastPct = pct;
                            transfer(id, pct);
                        }
                    }
                }
                int status = c.getResponseCode();
                InputStream body = status < 400 ? c.getInputStream() : c.getErrorStream();
                JSObject r = new JSObject();
                r.put("status", status);
                r.put("body", body != null ? readAll(body) : "");
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Invio al PC fallito: " + e.getMessage());
            } finally {
                if (c != null) c.disconnect();
                //noinspection ResultOfMethodCallIgnored
                new File(path).delete();
            }
        });
    }

    /** Every file under songs/ with its size, for syncing with the PC: {files: {"songs/x/a.flac": 123}}. */
    @PluginMethod
    public void listFiles(PluginCall call) {
        io.execute(() -> {
            try {
                File base = getContext().getFilesDir();
                JSONObject files = new JSONObject();
                java.util.ArrayDeque<File> todo = new java.util.ArrayDeque<>();
                todo.add(new File(base, "songs"));
                int cut = base.getAbsolutePath().length() + 1;
                while (!todo.isEmpty()) {
                    File[] kids = todo.poll().listFiles();
                    if (kids == null) continue;
                    for (File k : kids) {
                        if (k.isDirectory()) todo.add(k);
                        else if (!k.getName().endsWith(".part") && !k.getName().endsWith(".tmp"))
                            files.put(k.getAbsolutePath().substring(cut).replace('\\', '/'), k.length());
                    }
                }
                JSObject r = new JSObject();
                r.put("files", toJS(files));
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    /** Sends a file of the app's data folder to the PC (POST body = the file), keeping it here. */
    @PluginMethod
    public void pushFile(PluginCall call) {
        String id = call.getString("id", "");
        String rel = call.getString("path", "");
        String url = call.getString("url");
        String pin = call.getString("pin", "");
        String fingerprint = call.getString("fingerprint", "");
        if (rel.contains("..")) {
            call.reject("percorso non valido");
            return;
        }
        io.execute(() -> {
            HttpURLConnection c = null;
            try {
                File f = new File(getContext().getFilesDir(), rel);
                long size = f.length();
                c = bridgeConnection(url, fingerprint);
                c.setRequestMethod("POST");
                c.setDoOutput(true);
                c.setConnectTimeout(10_000);
                c.setReadTimeout(120_000);
                c.setFixedLengthStreamingMode(size);
                c.setRequestProperty("X-StemKit-Pin", pin);
                c.setRequestProperty("Content-Type", "application/octet-stream");
                try (InputStream in = new FileInputStream(f); OutputStream out = c.getOutputStream()) {
                    byte[] buf = new byte[1 << 16];
                    long sent = 0, lastPct = -1;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        sent += n;
                        long pct = size > 0 ? sent * 100 / size : 0;
                        if (pct != lastPct) {
                            lastPct = pct;
                            transfer(id, pct);
                        }
                    }
                }
                int status = c.getResponseCode();
                if (status != 200) throw new IllegalStateException("errore " + status);
                call.resolve();
            } catch (Exception e) {
                call.reject("Invio al PC fallito: " + e.getMessage());
            } finally {
                if (c != null) c.disconnect();
            }
        });
    }

    @PluginMethod
    public void download(PluginCall call) {
        String id = call.getString("id", "");
        String url = call.getString("url");
        String pin = call.getString("pin", "");
        String fingerprint = call.getString("fingerprint", "");
        String rel = call.getString("path", "");
        if (rel.contains("..")) {
            call.reject("percorso non valido");
            return;
        }
        io.execute(() -> {
            HttpURLConnection c = null;
            File dst = new File(getContext().getFilesDir(), rel);
            File tmp = new File(dst.getPath() + ".part");
            try {
                //noinspection ResultOfMethodCallIgnored
                dst.getParentFile().mkdirs();
                c = bridgeConnection(url, fingerprint);
                c.setConnectTimeout(10_000);
                c.setReadTimeout(120_000); // the PC may transcode the stem first
                c.setRequestProperty("X-StemKit-Pin", pin);
                int status = c.getResponseCode();
                if (status != 200) {
                    InputStream err = c.getErrorStream();
                    String msg = err != null ? readAll(err) : "";
                    try {
                        msg = new JSONObject(msg).optString("error", msg);
                    } catch (Exception ignored) {
                    }
                    throw new IllegalStateException(msg.isEmpty() ? "errore " + status : msg);
                }
                long size = c.getContentLengthLong();
                try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(tmp)) {
                    byte[] buf = new byte[1 << 16];
                    long got = 0, lastPct = -1;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        got += n;
                        long pct = size > 0 ? got * 100 / size : 0;
                        if (pct != lastPct) {
                            lastPct = pct;
                            transfer(id, pct);
                        }
                    }
                }
                if (dst.exists()) //noinspection ResultOfMethodCallIgnored
                    dst.delete();
                if (!tmp.renameTo(dst)) throw new IllegalStateException("salvataggio fallito");
                JSObject r = new JSObject();
                r.put("path", rel);
                r.put("size", dst.length());
                call.resolve(r);
            } catch (Exception e) {
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
                call.reject("Download fallito: " + e.getMessage());
            } finally {
                if (c != null) c.disconnect();
            }
        });
    }

    private static String readAll(InputStream in) throws Exception {
        try (InputStream s = in) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = s.read(buf)) > 0) b.write(buf, 0, n);
            return b.toString("UTF-8");
        }
    }

    // ---------------------------------------------------------- on-device separation

    @PluginMethod
    public void separate(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterNotificationPermission");
            return;
        }
        startSeparation(call);
    }

    @PermissionCallback
    private void afterNotificationPermission(PluginCall call) {
        // works without the notification too; it just stays hidden
        startSeparation(call);
    }

    private void startSeparation(PluginCall call) {
        String path = call.getString("uri");
        String youtubeId = call.getString("youtubeId");
        String songId = call.getString("songId");
        boolean existing = call.getBoolean("existing", false);
        if ((path == null && youtubeId == null && !existing) || songId == null || !songId.matches("[\\w-]+")
            || (youtubeId != null && !youtubeId.matches("[\\w-]{11}"))) {
            call.reject("parametri non validi");
            return;
        }
        if (SeparationService.isQueued(songId)) {
            call.reject("Questa canzone è già in preparazione");
            return;
        }
        String[] stems;
        try {
            JSONArray a = call.getArray("stems", new com.getcapacitor.JSArray());
            stems = new String[a.length()];
            for (int i = 0; i < a.length(); i++) stems[i] = a.getString(i);
        } catch (Exception e) {
            stems = new String[0];
        }
        Intent i = new Intent(getContext(), SeparationService.class)
            .putExtra("path", path)
            .putExtra("youtubeId", youtubeId)
            .putExtra("existing", existing)
            .putExtra("quality", call.getString("quality", "flac"))
            .putExtra("songId", songId)
            .putExtra("title", call.getString("title", "Canzone"))
            .putExtra("stems", stems);
        ContextCompat.startForegroundService(getContext(), i);
        call.resolve();
    }

    @PluginMethod
    public void cancelSeparation(PluginCall call) {
        if (call.getBoolean("all", false)) SeparationService.cancelAll();
        else SeparationService.requestCancel();
        call.resolve();
    }

    // ---------------------------------------------------------- YouTube on the phone

    @PluginMethod
    public void ytSearch(PluginCall call) {
        String q = call.getString("query", "").trim();
        if (q.isEmpty()) {
            call.reject("ricerca vuota");
            return;
        }
        io.execute(() -> {
            try {
                JSObject r = new JSObject();
                r.put("results", new com.getcapacitor.JSArray(YouTubeSource.search(q).toString()));
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Ricerca non riuscita: " + e.getMessage());
            }
        });
    }

    /** Song for listening only: the original audio, no separation (it can be split later). */
    @PluginMethod
    public void downloadYoutube(PluginCall call) {
        String videoId = call.getString("videoId", "");
        String songId = call.getString("songId", "");
        String title = call.getString("title", "Canzone");
        if (!videoId.matches("[\\w-]{11}") || !songId.matches("[\\w-]+")) {
            call.reject("parametri non validi");
            return;
        }
        io.execute(() -> {
            File dir = new File(getContext().getFilesDir(), "songs/" + songId);
            boolean existed = dir.isDirectory();
            try {
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
                File cached = StreamProxy.cachedFile(videoId);
                if (cached != null) { // already heard: the cache has it all
                    String name = cached.getName();
                    File out = new File(dir, "original" + name.substring(name.indexOf('.')));
                    try (InputStream in = new FileInputStream(cached); OutputStream o = new FileOutputStream(out)) {
                        byte[] buf = new byte[1 << 16];
                        int n;
                        while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
                    }
                    call.resolve(listenOnly(dir, songId, title, out, probeDuration(out)));
                    return;
                }
                YouTubeSource.Download d = YouTubeSource.download(videoId, dir, "original", f -> {
                    transfer(songId, f * 100);
                    return true;
                });
                call.resolve(listenOnly(dir, songId, title, d.file, d.durationSec));
            } catch (Exception e) {
                if (!existed) SeparationService.deleteTree(dir);
                call.reject("Download non riuscito: " + e.getMessage());
            }
        });
    }

    /** A file picked from the phone, added for listening only. */
    @PluginMethod
    public void importAudio(PluginCall call) {
        String path = call.getString("uri", "");
        String songId = call.getString("songId", "");
        String title = call.getString("title", "Canzone");
        if (!songId.matches("[\\w-]+") || !path.startsWith(getContext().getCacheDir().getAbsolutePath())) {
            call.reject("parametri non validi");
            return;
        }
        io.execute(() -> {
            File dir = new File(getContext().getFilesDir(), "songs/" + songId);
            try {
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
                File original = SeparationService.adoptPicked(new File(path), dir);
                call.resolve(listenOnly(dir, songId, title, original, probeDuration(original)));
            } catch (Exception e) {
                SeparationService.deleteTree(dir);
                call.reject("Non riesco ad aggiungere il file: " + e.getMessage());
            }
        });
    }

    private JSObject listenOnly(File dir, String songId, String title, File original, long durationSec) throws Exception {
        String rel = "songs/" + songId + "/" + original.getName();
        JSONObject meta = new JSONObject();
        meta.put("songId", songId);
        meta.put("title", title);
        meta.put("duration", durationSec);
        meta.put("stems", new JSONArray());
        meta.put("files", new JSONObject());
        meta.put("original", rel);
        meta.put("finishedAt", System.currentTimeMillis());
        SeparationService.writeAtomic(new File(dir, "meta.json"), meta.toString(2));
        JSObject r = new JSObject();
        r.put("original", rel);
        r.put("duration", durationSec);
        return r;
    }

    private static long probeDuration(File f) {
        android.media.MediaExtractor ex = new android.media.MediaExtractor();
        try {
            ex.setDataSource(f.getAbsolutePath());
            for (int i = 0; i < ex.getTrackCount(); i++) {
                android.media.MediaFormat fmt = ex.getTrackFormat(i);
                String mime = fmt.getString(android.media.MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/") && fmt.containsKey(android.media.MediaFormat.KEY_DURATION)) {
                    return Math.round(fmt.getLong(android.media.MediaFormat.KEY_DURATION) / 1e6);
                }
            }
        } catch (Exception ignored) {
        } finally {
            ex.release();
        }
        return 0;
    }

    /** Bytes used by each song folder: {songs: [{id, total, stems, original}], free}. */
    @PluginMethod
    public void storageUsage(PluginCall call) {
        io.execute(() -> {
            try {
                File root = new File(getContext().getFilesDir(), "songs");
                JSONArray out = new JSONArray();
                File[] dirs = root.listFiles();
                if (dirs != null) {
                    for (File d : dirs) {
                        if (!d.isDirectory()) continue;
                        long total = 0, original = 0;
                        File[] kids = d.listFiles();
                        if (kids != null) {
                            for (File k : kids) {
                                total += k.length();
                                if (k.getName().startsWith("original.")) original += k.length();
                            }
                        }
                        JSONObject o = new JSONObject();
                        o.put("id", d.getName());
                        o.put("total", total);
                        o.put("original", original);
                        o.put("stems", total - original);
                        out.put(o);
                    }
                }
                JSObject r = new JSObject();
                r.put("songs", new com.getcapacitor.JSArray(out.toString()));
                r.put("free", getContext().getFilesDir().getUsableSpace());
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    /** Frees space: removes a song's stems but keeps its original (it can be split again). */
    @PluginMethod
    public void deleteStems(PluginCall call) {
        String songId = call.getString("songId", "");
        if (!songId.matches("[\\w-]+")) {
            call.reject("parametri non validi");
            return;
        }
        io.execute(() -> {
            try {
                File dir = new File(getContext().getFilesDir(), "songs/" + songId);
                File original = SeparationService.findOriginal(dir);
                if (original == null) throw new IllegalStateException("questa canzone non ha l'originale: le tracce sono l'unico audio");
                File[] kids = dir.listFiles();
                if (kids != null) {
                    for (File k : kids) {
                        String n = k.getName();
                        if (!n.startsWith("original.") && !n.equals("meta.json") && !n.startsWith("cover.")) //noinspection ResultOfMethodCallIgnored
                            k.delete();
                    }
                }
                File metaFile = new File(dir, "meta.json");
                JSONObject meta = metaFile.isFile() ? new JSONObject(readAll(new FileInputStream(metaFile))) : new JSONObject();
                meta.put("songId", songId);
                meta.put("stems", new JSONArray());
                meta.put("files", new JSONObject());
                meta.put("original", "songs/" + songId + "/" + original.getName());
                if (!meta.has("finishedAt")) meta.put("finishedAt", System.currentTimeMillis());
                SeparationService.writeAtomic(metaFile, meta.toString(2));
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void spotifyList(PluginCall call) {
        String url = call.getString("url", "");
        io.execute(() -> {
            try {
                call.resolve(JSObject.fromJSONObject(YouTubeSource.spotifyList(url)));
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void matchSong(PluginCall call) {
        String title = call.getString("title", "");
        String artist = call.getString("artist", "");
        long dur = call.getInt("duration", 0);
        io.execute(() -> {
            try {
                call.resolve(JSObject.fromJSONObject(YouTubeSource.matchSong(title, artist, dur)));
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    /**
     * "Aggiornamento disponibile": downloads the APK of a GitHub release and
     * opens Android's installer. The first time Android asks to allow
     * installing from this app: then {needsPermission: true}, try again after.
     */
    @PluginMethod
    public void installUpdate(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("https://github.com/") && !url.startsWith("https://objects.githubusercontent.com/")) {
            call.reject("indirizzo non valido");
            return;
        }
        android.content.pm.PackageManager pm = getContext().getPackageManager();
        if (!pm.canRequestPackageInstalls()) {
            Intent i = new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            JSObject r = new JSObject();
            r.put("needsPermission", true);
            call.resolve(r);
            return;
        }
        io.execute(() -> {
            HttpURLConnection c = null;
            try {
                File dir = new File(getContext().getCacheDir(), "update");
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
                File apk = new File(dir, "OpenSpoty.apk");
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setInstanceFollowRedirects(true);
                c.setConnectTimeout(15_000);
                c.setReadTimeout(60_000);
                long size = c.getContentLengthLong();
                try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(apk)) {
                    byte[] buf = new byte[1 << 16];
                    long got = 0, last = -1;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        got += n;
                        long pct = size > 0 ? got * 100 / size : 0;
                        if (pct != last) {
                            last = pct;
                            transfer("update", pct);
                        }
                    }
                }
                Uri uri = androidx.core.content.FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
                Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
                JSObject r = new JSObject();
                r.put("needsPermission", false);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Aggiornamento non scaricato: " + e.getMessage());
            } finally {
                if (c != null) c.disconnect();
            }
        });
    }

    // ---------------------------------------------------------- "Cattura" (core/ShazamSignature)

    private volatile boolean captureStop;

    /**
     * Listens with the microphone and asks Shazam what is playing: first after
     * 4 seconds, then 8 and 12 (like Shazam), stopping at the first match.
     * Events "capture": {phase: listening|searching, seconds, level 0..1}.
     * Resolves {match: {title, artist, image, album, year, genre, url} | null}.
     */
    @PluginMethod
    public void capture(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "afterMicPermission");
            return;
        }
        startCapture(call);
    }

    @PermissionCallback
    private void afterMicPermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) startCapture(call);
        else call.reject("Serve il permesso del microfono per riconoscere la canzone");
    }

    @PluginMethod
    public void stopCapture(PluginCall call) {
        captureStop = true;
        call.resolve();
    }

    @android.annotation.SuppressLint("MissingPermission")
    private void startCapture(PluginCall call) {
        captureStop = false;
        io.execute(() -> {
            android.media.AudioRecord rec = null;
            try {
                int rate = app.stemkitmobile.core.ShazamSignature.RATE;
                int min = android.media.AudioRecord.getMinBufferSize(rate, android.media.AudioFormat.CHANNEL_IN_MONO, android.media.AudioFormat.ENCODING_PCM_16BIT);
                // the raw microphone (no voice processing): music is recognised better
                int source = android.media.MediaRecorder.AudioSource.UNPROCESSED;
                android.media.AudioManager am = (android.media.AudioManager) getContext().getSystemService(android.content.Context.AUDIO_SERVICE);
                if (!"true".equals(am.getProperty(android.media.AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED))) {
                    source = android.media.MediaRecorder.AudioSource.VOICE_RECOGNITION;
                }
                rec = new android.media.AudioRecord(source, rate, android.media.AudioFormat.CHANNEL_IN_MONO,
                    android.media.AudioFormat.ENCODING_PCM_16BIT, Math.max(min, rate));
                rec.startRecording();
                float[] all = new float[rate * 13];
                int got = 0, next = 4 * rate;
                short[] buf = new short[rate / 10];
                while (got < all.length && !captureStop) {
                    int n = rec.read(buf, 0, buf.length);
                    if (n <= 0) continue;
                    double sum = 0;
                    for (int i = 0; i < n && got < all.length; i++) {
                        float v = buf[i] / 32768f;
                        all[got++] = v;
                        sum += v * v;
                    }
                    captureEvent("listening", got / (float) rate, (float) Math.min(1, Math.sqrt(sum / n) * 6));
                    if (got >= next) {
                        captureEvent("searching", got / (float) rate, 0);
                        byte[] sig = app.stemkitmobile.core.ShazamSignature.compute(all, got);
                        JSONObject m = app.stemkitmobile.core.ShazamSignature.summary(app.stemkitmobile.core.ShazamSignature.recognize(sig, got));
                        if (m != null) {
                            JSObject r = new JSObject();
                            r.put("match", JSObject.fromJSONObject(m));
                            call.resolve(r);
                            return;
                        }
                        next += 4 * rate;
                    }
                }
                JSObject r = new JSObject();
                r.put("match", JSONObject.NULL);
                r.put("stopped", captureStop);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Riconoscimento non riuscito: " + e.getMessage());
            } finally {
                if (rec != null) {
                    try {
                        rec.stop();
                    } catch (Exception ignored) {
                    }
                    rec.release();
                }
            }
        });
    }

    private void captureEvent(String phase, float seconds, float level) {
        JSObject e = new JSObject();
        e.put("phase", phase);
        e.put("seconds", seconds);
        e.put("level", level);
        notifyListeners("capture", e);
    }

    /** resolves the YouTube streams of songs about to be played (search results, an album) */
    @PluginMethod
    public void warmStreams(PluginCall call) {
        try {
            JSONArray ids = call.getArray("videoIds", new com.getcapacitor.JSArray());
            int prefetch = call.getInt("prefetch", 0);
            // whole songs ahead of time only on Wi-Fi: on mobile data, just the addresses
            android.net.ConnectivityManager cm = (android.net.ConnectivityManager) getContext().getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
            if (cm == null || cm.isActiveNetworkMetered()) prefetch = 0;
            for (int i = 0; i < ids.length() && i < 6; i++) {
                String id = ids.getString(i);
                if (!id.matches("[\\w-]{11}")) continue;
                if (i < prefetch) StreamProxy.prefetch(id); // the likeliest: the whole song into the cache
                else StreamProxy.warm(id);
            }
        } catch (Exception ignored) {
        }
        call.resolve();
    }

    @PluginMethod
    public void suggest(PluginCall call) {
        String q = call.getString("query", "");
        io.execute(() -> {
            try {
                JSObject r = new JSObject();
                r.put("suggestions", new com.getcapacitor.JSArray(YouTubeSource.suggest(q).toString()));
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    /* Spotify catalogue for the artist / album pages (SpotifyCatalog.java) */
    @PluginMethod
    public void spSearch(PluginCall call) {
        String q = call.getString("query", "");
        io.execute(() -> {
            try {
                call.resolve(JSObject.fromJSONObject(SpotifyCatalog.search(q)));
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    /** podcasts (core/Podcasts): Apple's search */
    @PluginMethod
    public void podcastSearch(PluginCall call) {
        String q = call.getString("query", "");
        io.execute(() -> {
            try {
                JSObject r = new JSObject();
                r.put("results", new com.getcapacitor.JSArray(app.stemkitmobile.core.Podcasts.search(q).toString()));
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    /** a podcast's feed: its episodes */
    @PluginMethod
    public void podcastFeed(PluginCall call) {
        String url = call.getString("url", "");
        io.execute(() -> {
            try {
                call.resolve(JSObject.fromJSONObject(app.stemkitmobile.core.Podcasts.feed(url)));
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void spArtist(PluginCall call) {
        String uri = call.getString("uri", "");
        io.execute(() -> {
            try {
                call.resolve(JSObject.fromJSONObject(SpotifyCatalog.artist(uri)));
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void spAlbum(PluginCall call) {
        String uri = call.getString("uri", "");
        io.execute(() -> {
            try {
                call.resolve(JSObject.fromJSONObject(SpotifyCatalog.album(uri)));
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void spotifyQuery(PluginCall call) {
        String url = call.getString("url", "");
        io.execute(() -> {
            try {
                JSObject r = new JSObject();
                r.put("query", YouTubeSource.spotifyQuery(url));
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void separationStatus(PluginCall call) {
        JSONObject e = SeparationService.lastEvent;
        if (e == null || (!SeparationService.isRunning() && "running".equals(e.optString("state")))) {
            JSObject idle = new JSObject();
            idle.put("state", "idle");
            call.resolve(idle);
            return;
        }
        call.resolve(toJS(e));
    }
}
