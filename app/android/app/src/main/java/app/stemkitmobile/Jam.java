package app.stemkitmobile;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

import app.stemkitmobile.audio.Engine;

/**
 * "Jam", like Spotify's: friends on the same Wi-Fi add songs to a shared queue
 * that plays on this phone. Everything lives here, natively, so the Jam goes on
 * with the screen locked (the app's JavaScript is asleep then):
 * - a small HTTP server on the LAN: the guest page (assets/jam/index.html) for
 *   friends without the app, and the JSON API both the page and other
 *   OpenSpoty apps use (state, search, add, controls);
 * - the shared queue, which the engine plays before its own list (NextSource);
 * - the Jam announced on the network (NSD), so OpenSpoty apps nearby find it.
 * Access needs the Jam's key (in the QR / link, and in the announcement).
 */
final class Jam implements Engine.NextSource {
    private static final String TAG = "StemKitJam";
    static final String SERVICE = "_openspotyjam._tcp";
    private static final long GUEST_TIMEOUT = 40_000;

    static final class Item {
        String key, by;
        Engine.Spec spec;

        JSONObject json() throws Exception {
            return new JSONObject().put("key", key).put("by", by).put("songId", spec.songId).put("title", spec.title)
                .put("name", spec.name).put("artist", spec.artist).put("art", spec.art == null ? "" : spec.art)
                .put("duration", spec.durationHint);
        }
    }

    private static Jam instance;

    static synchronized Jam get(Context ctx) {
        if (instance == null) instance = new Jam(ctx.getApplicationContext());
        return instance;
    }

    private final Context ctx;
    private final Engine engine;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final SecureRandom random = new SecureRandom();
    private volatile Consumer<JSONObject> listener;

    // guarded by this
    private ServerSocket server;
    private String token, host = "";
    private boolean allowControl = true;
    private final List<Item> queue = new ArrayList<>();
    private final Map<String, Long> guests = new LinkedHashMap<>();
    private final Map<String, String> localArt = new HashMap<>(); // songId -> artwork file, served to guests
    private int nextKey;
    private NsdManager.RegistrationListener registration;
    private android.net.wifi.WifiManager.WifiLock wifiLock; // friends reach this phone with its screen off too

    private Jam(Context ctx) {
        this.ctx = ctx;
        this.engine = Engine.get(ctx);
    }

    /** jam state changes (also to the app, as 'jam' events) */
    void setListener(Consumer<JSONObject> l) {
        listener = l;
    }

    // ------------------------------------------------------------ host

    JSONObject start(String hostName, boolean control) throws Exception {
        synchronized (this) {
            if (server == null) {
                byte[] b = new byte[6];
                random.nextBytes(b);
                StringBuilder k = new StringBuilder();
                for (byte x : b) k.append(String.format("%02x", x));
                token = k.toString();
                host = hostName == null || hostName.trim().isEmpty() ? "OpenSpoty" : hostName.trim();
                allowControl = control;
                server = new ServerSocket(0, 50);
                ServerSocket s = server;
                Thread t = new Thread(() -> accept(s), "stemkit-jam");
                t.setDaemon(true);
                t.start();
                announce(s.getLocalPort());
                try {
                    android.net.wifi.WifiManager wm = (android.net.wifi.WifiManager) ctx.getSystemService(Context.WIFI_SERVICE);
                    wifiLock = wm.createWifiLock(android.net.wifi.WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "stemkit:jam");
                    wifiLock.acquire();
                } catch (Exception e) {
                    Log.w(TAG, "wifi lock", e);
                }
            }
        }
        engine.setNextSource(this);
        changed();
        return state(null);
    }

    void stop() {
        synchronized (this) {
            if (server == null) return;
            try {
                server.close();
            } catch (IOException ignored) {
            }
            server = null;
            token = null;
            queue.clear();
            guests.clear();
            localArt.clear();
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
            wifiLock = null;
            if (registration != null) {
                try {
                    nsd().unregisterService(registration);
                } catch (Exception ignored) {
                }
                registration = null;
            }
        }
        engine.setNextSource(null);
        engine.preloadNext();
        changed();
    }

    synchronized boolean active() {
        return server != null;
    }

    synchronized void setAllowControl(boolean on) {
        allowControl = on;
        changedLater();
    }

    /** the host (the app) adds a song of its own: its spec is complete already */
    void addSpec(Engine.Spec spec, String by) {
        enqueue(spec, by);
    }

    /** remove ("remove"), or move one place ("up" / "down") */
    boolean edit(String key, String action, String who) {
        synchronized (this) {
            int i = indexOf(key);
            if (i < 0) return false;
            // without "controlli per tutti" a guest only removes what they added
            if (who != null && !allowControl && !("remove".equals(action) && who.equals(queue.get(i).by))) return false;
            switch (action) {
                case "remove":
                    queue.remove(i);
                    break;
                case "up":
                    if (i > 0) Collections.swap(queue, i, i - 1);
                    break;
                case "down":
                    if (i + 1 < queue.size()) Collections.swap(queue, i, i + 1);
                    break;
                default:
                    return false;
            }
        }
        engine.preloadNext();
        changed();
        return true;
    }

    private int indexOf(String key) {
        for (int i = 0; i < queue.size(); i++) if (queue.get(i).key.equals(key)) return i;
        return -1;
    }

    private void enqueue(Engine.Spec spec, String by) {
        boolean first;
        synchronized (this) {
            if (server == null) return;
            Item it = new Item();
            it.key = "j" + (++nextKey);
            it.by = by;
            it.spec = spec;
            if (spec.art != null && spec.art.startsWith("/")) localArt.put(spec.songId, spec.art);
            queue.add(it);
            first = queue.size() == 1;
        }
        // nothing playing (or the last song over): the Jam starts at once, as on Spotify
        if (engine.finished()) {
            PlaybackService.start(ctx);
            engine.next();
        }
        else if (first) engine.preloadNext();
        changed();
    }

    // ------------------------------------------------------------ Engine.NextSource

    @Override
    public synchronized Engine.Spec peek() {
        return queue.isEmpty() ? null : queue.get(0).spec;
    }

    @Override
    public Engine.Spec poll() {
        Engine.Spec s;
        synchronized (this) {
            if (queue.isEmpty()) return null;
            s = queue.remove(0).spec;
        }
        changedLater();
        return s;
    }

    // ------------------------------------------------------------ state

    /** what the guests (and the app) see; who = the guest asking (null: the app) */
    JSONObject state(String who) throws Exception {
        JSONObject now = engine.snapshot();
        JSONObject o = new JSONObject();
        JSONArray q = new JSONArray(), people = new JSONArray();
        synchronized (this) {
            o.put("active", server != null);
            if (server == null) return o;
            long t = System.currentTimeMillis();
            if (who != null && !who.isEmpty()) guests.put(who, t);
            for (Iterator<Map.Entry<String, Long>> it = guests.entrySet().iterator(); it.hasNext(); ) {
                Map.Entry<String, Long> e = it.next();
                if (t - e.getValue() > GUEST_TIMEOUT) it.remove();
                else people.put(e.getKey());
            }
            for (Item it : queue) q.put(it.json());
            o.put("host", host).put("allowControl", allowControl).put("url", url()).put("guests", people).put("queue", q);
            String art = now.optString("art", "");
            if (art.startsWith("/")) localArt.put(now.optString("songId"), art);
        }
        o.put("now", new JSONObject().put("songId", now.opt("songId")).put("title", now.optString("title"))
            .put("name", now.optString("name")).put("artist", now.optString("artist")).put("art", now.optString("art"))
            .put("playing", now.optBoolean("playing")).put("loading", now.optBoolean("loading"))
            .put("pos", now.optDouble("pos", 0)).put("dur", now.optDouble("dur", 0)));
        return o;
    }

    private synchronized String url() {
        if (server == null) return "";
        return "http://" + lanAddress() + ":" + server.getLocalPort() + "/?k=" + token;
    }

    private void changed() {
        Consumer<JSONObject> l = listener;
        if (l == null) return;
        try {
            l.accept(state(null).put("type", "jam"));
        } catch (Exception e) {
            Log.w(TAG, "state", e);
        }
    }

    private void changedLater() {
        pool.execute(this::changed);
    }

    /** this phone's address on the Wi-Fi (or its own hotspot) */
    static String lanAddress() {
        String best = null;
        int bestRank = 99;
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                String n = ni.getName();
                int rank = n.startsWith("wlan") ? 0 : n.startsWith("ap") || n.startsWith("swlan") ? 1 : n.startsWith("rmnet") ? 9 : 5;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && a.isSiteLocalAddress() && rank < bestRank) {
                        best = a.getHostAddress();
                        bestRank = rank;
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "address", e);
        }
        return best != null ? best : "127.0.0.1";
    }

    private NsdManager nsd() {
        return (NsdManager) ctx.getSystemService(Context.NSD_SERVICE);
    }

    private void announce(int port) {
        NsdServiceInfo info = new NsdServiceInfo();
        info.setServiceName("Jam di " + host);
        info.setServiceType(SERVICE);
        info.setPort(port);
        info.setAttribute("k", token);
        info.setAttribute("h", host);
        registration = new NsdManager.RegistrationListener() {
            @Override
            public void onRegistrationFailed(NsdServiceInfo s, int err) {
                Log.w(TAG, "announce failed " + err);
            }

            @Override
            public void onUnregistrationFailed(NsdServiceInfo s, int err) {
            }

            @Override
            public void onServiceRegistered(NsdServiceInfo s) {
            }

            @Override
            public void onServiceUnregistered(NsdServiceInfo s) {
            }
        };
        try {
            nsd().registerService(info, NsdManager.PROTOCOL_DNS_SD, registration);
        } catch (Exception e) {
            Log.w(TAG, "announce", e);
            registration = null;
        }
    }

    // ------------------------------------------------------------ HTTP server

    private void accept(ServerSocket s) {
        while (!s.isClosed()) {
            try {
                Socket c = s.accept();
                pool.execute(() -> serve(c));
            } catch (IOException e) {
                if (!s.isClosed()) Log.w(TAG, "accept", e);
            }
        }
    }

    private void serve(Socket c) {
        try (Socket sock = c) {
            sock.setSoTimeout(15_000);
            InputStream in = sock.getInputStream();
            String line = readLine(in);
            if (line == null) return;
            String[] parts = line.split(" ");
            if (parts.length < 2) return;
            String method = parts[0];
            int len = 0;
            String h;
            while ((h = readLine(in)) != null && !h.isEmpty()) {
                int i = h.indexOf(':');
                if (i > 0 && h.substring(0, i).trim().equalsIgnoreCase("content-length")) len = Integer.parseInt(h.substring(i + 1).trim());
            }
            if (len > 65536) return;
            byte[] body = new byte[len];
            int got = 0;
            while (got < len) {
                int n = in.read(body, got, len - got);
                if (n < 0) break;
                got += n;
            }
            String target = parts[1];
            int qm = target.indexOf('?');
            String path = qm >= 0 ? target.substring(0, qm) : target;
            Map<String, String> q = query(qm >= 0 ? target.substring(qm + 1) : "");
            route(sock.getOutputStream(), method, path, q, new String(body, StandardCharsets.UTF_8));
        } catch (Exception e) {
            Log.w(TAG, "serve", e);
        }
    }

    private void route(OutputStream out, String method, String path, Map<String, String> q, String body) throws Exception {
        if (path.equals("/") || path.equals("/index.html")) {
            try (InputStream a = ctx.getAssets().open("jam/index.html")) {
                send(out, 200, "text/html; charset=utf-8", readAll(a));
            }
            return;
        }
        String k;
        synchronized (this) {
            k = token;
        }
        if (k == null || !k.equals(q.get("k"))) {
            json(out, 403, new JSONObject().put("error", "Jam finita o link non valido"));
            return;
        }
        String who = q.getOrDefault("who", "");
        if (who.length() > 40) who = who.substring(0, 40);
        switch (path) {
            case "/api/state":
                json(out, 200, state(who));
                return;
            case "/api/art": {
                String f;
                synchronized (this) {
                    f = localArt.get(q.getOrDefault("id", ""));
                }
                if (f == null || !new File(f).isFile()) {
                    send(out, 404, "text/plain", new byte[0]);
                    return;
                }
                send(out, 200, f.endsWith(".png") ? "image/png" : "image/jpeg", java.nio.file.Files.readAllBytes(new File(f).toPath()));
                return;
            }
            case "/api/search": {
                JSONObject r = SpotifyCatalog.search(q.getOrDefault("q", ""));
                json(out, 200, new JSONObject().put("tracks", r.optJSONArray("tracks")));
                return;
            }
            case "/api/add": {
                if (!"POST".equals(method)) break;
                Engine.Spec s = specFor(new JSONObject(body));
                enqueue(s, who.isEmpty() ? "Ospite" : who);
                json(out, 200, new JSONObject().put("ok", true).put("title", s.title));
                return;
            }
            case "/api/control": {
                if (!"POST".equals(method)) break;
                JSONObject b = new JSONObject(body);
                String action = b.optString("action");
                boolean ok;
                boolean control;
                synchronized (this) {
                    control = allowControl;
                }
                if (action.equals("remove") || action.equals("up") || action.equals("down")) ok = edit(b.optString("key"), action, who);
                else if (!control) ok = false;
                else {
                    ok = true;
                    switch (action) {
                        case "play":
                            engine.play();
                            break;
                        case "pause":
                            engine.pause();
                            break;
                        case "next":
                            engine.next();
                            break;
                        case "prev":
                            engine.prev();
                            break;
                        default:
                            ok = false;
                    }
                }
                json(out, ok ? 200 : 403, new JSONObject().put("ok", ok).put("error", ok ? "" : "Il padrone della Jam non lo permette"));
                return;
            }
            default:
        }
        json(out, 404, new JSONObject().put("error", "non trovato"));
    }

    /**
     * A guest's song: {videoId} (a song from an OpenSpoty library), or a Spotify
     * track {title, artists[], duration, image}, looked up on YouTube like the app does.
     */
    private static Engine.Spec specFor(JSONObject t) throws Exception {
        String title = t.optString("title", "").trim();
        JSONArray a = t.optJSONArray("artists");
        List<String> names = new ArrayList<>();
        for (int i = 0; a != null && i < a.length(); i++) if (!a.optString(i).isEmpty()) names.add(a.optString(i));
        String artist = t.optString("artist", String.join(", ", names));
        String vid = t.optString("videoId", "");
        if (!vid.matches("[\\w-]{11}")) {
            if (title.isEmpty()) throw new IllegalArgumentException("brano senza titolo");
            vid = YouTubeSource.matchSong(title, artist, t.optLong("duration", 0)).getString("videoId");
        }
        Engine.Spec s = new Engine.Spec();
        s.songId = "yt-" + vid;
        s.name = title;
        s.artist = artist;
        s.title = artist.isEmpty() ? title : artist + " – " + title;
        s.original = StreamProxy.url(vid);
        s.durationHint = t.optDouble("duration", 0);
        String img = t.optString("image", "");
        s.art = img.startsWith("https://") ? img : "https://i.ytimg.com/vi/" + vid + "/hqdefault.jpg";
        return s;
    }

    private static Map<String, String> query(String s) {
        Map<String, String> m = new HashMap<>();
        for (String p : s.split("&")) {
            int i = p.indexOf('=');
            if (i <= 0) continue;
            try {
                m.put(URLDecoder.decode(p.substring(0, i), "UTF-8"), URLDecoder.decode(p.substring(i + 1), "UTF-8"));
            } catch (Exception ignored) {
            }
        }
        return m;
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) >= 0) {
            if (c == '\n') break;
            if (c != '\r') b.write(c);
            if (b.size() > 8192) return null;
        }
        if (c < 0 && b.size() == 0) return null;
        return b.toString("UTF-8");
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
        return b.toByteArray();
    }

    private static void json(OutputStream out, int code, JSONObject o) throws IOException {
        send(out, code, "application/json; charset=utf-8", o.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static void send(OutputStream out, int code, String type, byte[] body) throws IOException {
        String head = "HTTP/1.1 " + code + (code == 200 ? " OK" : " Error") + "\r\nContent-Type: " + type + "\r\nContent-Length: " + body.length
            + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        out.write(body);
        out.flush();
    }

    // ------------------------------------------------------------ guest (an OpenSpoty app joining someone's Jam)

    private NsdManager.DiscoveryListener discovery;
    private final List<NsdServiceInfo> toResolve = new ArrayList<>();
    private boolean resolving;

    /** Jams on this network, each reported once resolved: {type: 'jamFound', name, url} / {type: 'jamLost', name} */
    synchronized void discover(boolean on, Consumer<JSONObject> found) {
        NsdManager m = nsd();
        if (discovery != null) {
            try {
                m.stopServiceDiscovery(discovery);
            } catch (Exception ignored) {
            }
            discovery = null;
            toResolve.clear();
        }
        if (!on) return;
        discovery = new NsdManager.DiscoveryListener() {
            @Override
            public void onStartDiscoveryFailed(String t, int err) {
                Log.w(TAG, "discovery failed " + err);
            }

            @Override
            public void onStopDiscoveryFailed(String t, int err) {
            }

            @Override
            public void onDiscoveryStarted(String t) {
            }

            @Override
            public void onDiscoveryStopped(String t) {
            }

            @Override
            public void onServiceFound(NsdServiceInfo s) {
                synchronized (Jam.this) {
                    toResolve.add(s);
                }
                resolveNext(found);
            }

            @Override
            public void onServiceLost(NsdServiceInfo s) {
                try {
                    found.accept(new JSONObject().put("type", "jamLost").put("name", s.getServiceName()));
                } catch (Exception ignored) {
                }
            }
        };
        m.discoverServices(SERVICE, NsdManager.PROTOCOL_DNS_SD, discovery);
    }

    /** one at a time: NsdManager resolves a single service at once */
    @SuppressWarnings("deprecation")
    private void resolveNext(Consumer<JSONObject> found) {
        NsdServiceInfo s;
        synchronized (this) {
            if (resolving || toResolve.isEmpty()) return;
            s = toResolve.remove(0);
            resolving = true;
        }
        nsd().resolveService(s, new NsdManager.ResolveListener() {
            @Override
            public void onResolveFailed(NsdServiceInfo i, int err) {
                done();
            }

            @Override
            public void onServiceResolved(NsdServiceInfo i) {
                try {
                    byte[] k = i.getAttributes().get("k");
                    InetAddress addr = i.getHost();
                    if (k != null && addr instanceof Inet4Address) {
                        String key = new String(k, StandardCharsets.UTF_8);
                        boolean mine;
                        synchronized (Jam.this) {
                            mine = key.equals(token);
                        }
                        if (!mine) {
                            found.accept(new JSONObject().put("type", "jamFound").put("name", i.getServiceName())
                                .put("url", "http://" + addr.getHostAddress() + ":" + i.getPort() + "/?k=" + key));
                        }
                    }
                } catch (Exception e) {
                    Log.w(TAG, "resolved", e);
                }
                done();
            }

            private void done() {
                synchronized (Jam.this) {
                    resolving = false;
                }
                resolveNext(found);
            }
        });
    }

    /** a request to another phone's Jam (from Java: the app's page may not call plain http) */
    static String request(String base, String path, String method, String body) throws IOException {
        URL u = new URL(new URL(base), path);
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        c.setConnectTimeout(5000);
        c.setReadTimeout(30_000); // adding a song looks it up on YouTube first
        c.setRequestMethod(method);
        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream o = c.getOutputStream()) {
                o.write(body.getBytes(StandardCharsets.UTF_8));
            }
        }
        try {
            int code = c.getResponseCode();
            InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
            String text = in == null ? "" : new String(readAll(in), StandardCharsets.UTF_8);
            if (code >= 400) {
                String msg = text;
                try {
                    msg = new JSONObject(text).optString("error", text);
                } catch (Exception ignored) {
                }
                throw new IOException(msg.isEmpty() ? "errore " + code : msg);
            }
            return text;
        } finally {
            c.disconnect();
        }
    }
}
