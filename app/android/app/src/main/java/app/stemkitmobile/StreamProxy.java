package app.stemkitmobile;

import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Plays YouTube audio without downloading it into the library, like Spotify:
 * the player opens http://127.0.0.1:port/yt/<id> and this proxy fills a cache
 * file from YouTube in 2 MB ranges (fast, never throttled) while serving the
 * bytes as they arrive. The cache is trimmed to {@link #MAX_CACHE} (oldest
 * first); "Scarica" copies a complete cache file into the song's folder.
 */
final class StreamProxy {
    private static final String TAG = "StemKitStream";
    private static final long MAX_CACHE = 1024L << 20;
    private static final long CHUNK = 2L << 20;
    private static final Pattern REQ = Pattern.compile("^(GET|HEAD) /yt/([\\w-]{11}) ");
    private static final Pattern RANGE = Pattern.compile("bytes=(\\d+)-(\\d*)");
    private static final byte[] BAD_GATEWAY =
        "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1);

    private static File dir;
    private static int port;
    private static final Map<String, Fill> fills = new HashMap<>();
    /* resolved stream addresses (YouTube keeps them valid for ~6 h) */
    private static final Map<String, YouTubeSource.Audio> audios = new HashMap<>();
    private static final Map<String, Long> audioAt = new HashMap<>();
    private static final ExecutorService pool = Executors.newCachedThreadPool();

    private StreamProxy() {}

    static synchronized void start(File cacheRoot) {
        if (port != 0) return;
        dir = new File(cacheRoot, "stream");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        try {
            ServerSocket server = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
            port = server.getLocalPort();
            Thread t = new Thread(() -> {
                while (true) {
                    try {
                        Socket s = server.accept();
                        pool.execute(() -> serve(s));
                    } catch (IOException e) {
                        Log.w(TAG, "accept", e);
                    }
                }
            }, "stemkit-stream");
            t.setDaemon(true);
            t.start();
        } catch (IOException e) {
            Log.e(TAG, "no proxy", e);
        }
    }

    static String url(String videoId) {
        return "http://127.0.0.1:" + port + "/yt/" + videoId;
    }

    /** the complete cached audio of a video, or null */
    static File cachedFile(String videoId) {
        File[] f = dir == null ? null : dir.listFiles((d, n) -> n.startsWith(videoId + ".") && !n.endsWith(".part"));
        if (f == null || f.length == 0) return null;
        //noinspection ResultOfMethodCallIgnored
        f[0].setLastModified(System.currentTimeMillis());
        return f[0];
    }

    /** looks the stream up in advance, so pressing play only has to fetch audio */
    static void warm(String videoId) {
        if (cachedFile(videoId) != null) return;
        pool.execute(() -> {
            try {
                audio(videoId, false);
            } catch (Exception ignored) {
            }
        });
    }

    /** fetches the whole song into the cache in the background (the one you are most likely to play) */
    static void prefetch(String videoId) {
        if (cachedFile(videoId) == null) fill(videoId);
    }

    private static YouTubeSource.Audio audio(String videoId, boolean fresh) throws Exception {
        synchronized (audios) {
            Long at = audioAt.get(videoId);
            if (!fresh && at != null && System.currentTimeMillis() - at < 4 * 3600_000L) return audios.get(videoId);
        }
        YouTubeSource.Audio a = YouTubeSource.bestAudio(videoId);
        synchronized (audios) {
            audios.put(videoId, a);
            audioAt.put(videoId, System.currentTimeMillis());
        }
        return a;
    }

    /** downloads the whole stream into the cache (if it isn't there yet) and returns it */
    static File ensureCached(String videoId) throws Exception {
        File done = cachedFile(videoId);
        if (done != null) return done;
        Fill f = fill(videoId);
        synchronized (f) {
            while (!f.complete && f.error == null) f.wait(500);
            if (f.error != null) throw f.error;
        }
        return f.done;
    }

    // ------------------------------------------------------------ filling the cache

    private static final class Fill {
        final String videoId;
        YouTubeSource.Audio audio;
        File part, done;
        long length = -1, have; // bytes written from the start
        boolean complete;
        Exception error;
        int readers;

        Fill(String videoId) {
            this.videoId = videoId;
        }
    }

    private static Fill fill(String videoId) {
        synchronized (fills) {
            Fill f = fills.get(videoId);
            if (f != null && f.error == null) return f;
            Fill nf = new Fill(videoId);
            fills.put(videoId, nf);
            pool.execute(() -> run(nf));
            return nf;
        }
    }

    private static void run(Fill f) {
        try {
            f.audio = audio(f.videoId, false);
            File part = new File(dir, f.videoId + ".part");
            synchronized (f) {
                f.part = part;
                f.length = f.audio.length;
            }
            boolean retried = false;
            try (FileOutputStream out = new FileOutputStream(part)) {
                long pos = 0;
                while (f.length < 0 || pos < f.length) {
                    HttpURLConnection c = YouTubeSource.openRange(f.audio.url, pos, pos + CHUNK - 1);
                    int code = c.getResponseCode();
                    if (code == 403 && !retried) { // the address expired: ask again
                        retried = true;
                        f.audio = audio(f.videoId, true);
                        continue;
                    }
                    if (code != 200 && code != 206) throw new IOException("YouTube ha risposto " + code);
                    if (f.length < 0) {
                        String cr = c.getHeaderField("Content-Range");
                        long len = cr != null && cr.contains("/") ? Long.parseLong(cr.substring(cr.indexOf('/') + 1).trim()) : c.getContentLengthLong();
                        synchronized (f) {
                            f.length = len;
                            f.notifyAll();
                        }
                    }
                    long got = 0;
                    try (InputStream in = c.getInputStream()) {
                        byte[] buf = new byte[1 << 16];
                        int n;
                        while ((n = in.read(buf)) > 0) {
                            out.write(buf, 0, n);
                            got += n;
                            synchronized (f) {
                                f.have = pos + got;
                                f.notifyAll();
                            }
                        }
                    } finally {
                        c.disconnect();
                    }
                    pos += got;
                    if (got == 0 || code == 200) break;
                }
            }
            File done = new File(dir, f.videoId + "." + f.audio.suffix);
            if (!part.renameTo(done)) throw new IOException("cache non salvata");
            synchronized (f) {
                f.done = done;
                f.part = done; // readers keep going on the renamed file
                f.complete = true;
                f.length = f.have;
                f.notifyAll();
            }
            trim();
        } catch (Exception e) {
            Log.w(TAG, "fill " + f.videoId, e);
            synchronized (f) {
                f.error = e;
                f.notifyAll();
            }
        } finally {
            synchronized (fills) {
                if (fills.get(f.videoId) == f && (f.complete || f.error != null)) fills.remove(f.videoId);
            }
        }
    }

    /** oldest cached songs go first; files being played are kept */
    private static void trim() {
        File[] files = dir.listFiles((d, n) -> !n.endsWith(".part"));
        if (files == null) return;
        Arrays.sort(files, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
        long total = 0;
        for (File f : files) {
            total += f.length();
            if (total > MAX_CACHE) {
                String id = f.getName().substring(0, Math.min(11, f.getName().length()));
                synchronized (fills) {
                    if (fills.containsKey(id)) continue;
                }
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
    }

    // ------------------------------------------------------------ HTTP

    private static void serve(Socket s) {
        try (Socket sock = s) {
            sock.setSoTimeout(60_000);
            BufferedReader in = new BufferedReader(new InputStreamReader(sock.getInputStream(), StandardCharsets.ISO_8859_1));
            String line = in.readLine();
            if (line == null) return;
            Matcher m = REQ.matcher(line);
            long from = 0, to = -1;
            String h;
            while ((h = in.readLine()) != null && !h.isEmpty()) {
                if (h.regionMatches(true, 0, "Range:", 0, 6)) {
                    Matcher r = RANGE.matcher(h);
                    if (r.find()) {
                        from = Long.parseLong(r.group(1));
                        if (!r.group(2).isEmpty()) to = Long.parseLong(r.group(2));
                    }
                }
            }
            OutputStream out = sock.getOutputStream();
            if (!m.find()) {
                out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
                return;
            }
            boolean head = "HEAD".equals(m.group(1));
            String id = m.group(2);
            File cached = cachedFile(id);
            if (cached != null) {
                sendFile(out, cached, mimeOf(cached.getName()), from, to, head);
                return;
            }
            Fill f = fill(id);
            long length;
            synchronized (f) {
                while (f.length < 0 && f.error == null) f.wait(200);
                if (f.error != null) {
                    // a clear refusal: the player gives up at once instead of retrying
                    out.write(BAD_GATEWAY);
                    return;
                }
                f.readers++;
                length = f.length;
            }
            try {
                if (to < 0 || to >= length) to = length - 1;
                String mime = f.audio != null ? f.audio.mime : "audio/webm";
                writeHeaders(out, from, to, length, mime);
                if (head) return;
                long have;
                synchronized (f) {
                    have = f.complete ? Long.MAX_VALUE : f.have;
                }
                if (from > have + (1 << 20) && f.audio != null) {
                    // far ahead of the download (a WebM index at the end, a seek): straight from YouTube
                    pipe(f.audio.url, from, to, out);
                    return;
                }
                byte[] buf = new byte[1 << 16];
                long pos = from;
                while (pos <= to) {
                    long avail;
                    File src;
                    synchronized (f) {
                        while (f.have <= pos && !f.complete && f.error == null) f.wait(200);
                        if (f.error != null && f.have <= pos) throw f.error;
                        avail = Math.min(f.have, to + 1) - pos;
                        src = f.part;
                    }
                    if (avail <= 0) break;
                    try (RandomAccessFile raf = new RandomAccessFile(src, "r")) {
                        raf.seek(pos);
                        while (avail > 0) {
                            int n = raf.read(buf, 0, (int) Math.min(buf.length, avail));
                            if (n <= 0) break;
                            out.write(buf, 0, n);
                            pos += n;
                            avail -= n;
                        }
                    }
                }
                out.flush();
            } finally {
                synchronized (f) {
                    f.readers--;
                }
            }
        } catch (Exception e) {
            // the player closed the connection (seek, next song): normal
        }
    }

    private static void pipe(String url, long from, long to, OutputStream out) throws IOException {
        byte[] buf = new byte[1 << 16];
        for (long pos = from; pos <= to; ) {
            long end = Math.min(to, pos + CHUNK - 1);
            HttpURLConnection c = YouTubeSource.openRange(url, pos, end);
            try (InputStream in = c.getInputStream()) {
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    pos += n;
                }
            } finally {
                c.disconnect();
            }
            if (pos <= end) break; // short answer: give up, the player retries
        }
        out.flush();
    }

    private static String mimeOf(String name) {
        return name.endsWith(".m4a") ? "audio/mp4" : name.endsWith(".webm") ? "audio/webm" : "application/octet-stream";
    }

    private static void writeHeaders(OutputStream out, long from, long to, long length, String mime) throws IOException {
        String head = (from > 0 || to < length - 1 ? "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes " + from + "-" + to + "/" + length + "\r\n"
            : "HTTP/1.1 200 OK\r\n")
            + "Content-Type: " + mime + "\r\nContent-Length: " + (to - from + 1) + "\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
    }

    private static void sendFile(OutputStream out, File f, String mime, long from, long to, boolean head) throws IOException {
        long length = f.length();
        if (to < 0 || to >= length) to = length - 1;
        writeHeaders(out, from, to, length, mime);
        if (head) return;
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            raf.seek(from);
            byte[] buf = new byte[1 << 16];
            long left = to - from + 1;
            while (left > 0) {
                int n = raf.read(buf, 0, (int) Math.min(buf.length, left));
                if (n <= 0) break;
                out.write(buf, 0, n);
                left -= n;
            }
        }
        out.flush();
    }
}
