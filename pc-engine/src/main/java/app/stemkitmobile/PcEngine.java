package app.stemkitmobile;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * JSON-lines server for bridge/stemkit_bridge.py: one request per stdin line
 * {id, op, ...}, answered on stdout with {id, ok, result | error}; downloads
 * also send {id, progress}. Requests run in parallel.
 */
public final class PcEngine {
    private static final PrintStream OUT = new PrintStream(System.out, true, StandardCharsets.UTF_8);
    private static final ExecutorService POOL = Executors.newCachedThreadPool();

    public static void main(String[] args) throws Exception {
        System.setOut(System.err); // only answers go to stdout
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            if (line.isBlank()) continue;
            JSONObject req = new JSONObject(line);
            POOL.execute(() -> handle(req));
        }
        System.exit(0); // the bridge went away
    }

    private static void handle(JSONObject req) {
        long id = req.optLong("id");
        JSONObject res = new JSONObject().put("id", id);
        try {
            res.put("result", run(id, req)).put("ok", true);
        } catch (Throwable e) {
            res.put("ok", false).put("error", e.getMessage() != null ? e.getMessage() : e.toString());
        }
        send(res);
    }

    private static Object run(long id, JSONObject r) throws Exception {
        switch (r.getString("op")) {
            case "search":
                return YouTubeSource.search(r.getString("query"));
            case "match":
                return YouTubeSource.matchSong(r.getString("title"), r.optString("artist"), r.optLong("duration"));
            case "spotifyList":
                return YouTubeSource.spotifyList(r.getString("url"));
            case "spSearch":
                return SpotifyCatalog.search(r.getString("query"));
            case "spArtist":
                return SpotifyCatalog.artist(r.getString("uri"));
            case "spAlbum":
                return SpotifyCatalog.album(r.getString("uri"));
            case "chords":
                return chords(id, r.getString("path"), r.getString("ffmpeg"), r.getString("model"));
            case "spotifyQuery":
                return YouTubeSource.spotifyQuery(r.getString("url"));
            case "download": {
                long[] last = {-1};
                YouTubeSource.Download d = YouTubeSource.download(r.getString("videoId"), new File(r.getString("dir")), r.optString("baseName", "original"), f -> {
                    long pct = Math.round(f * 100);
                    if (pct != last[0]) {
                        last[0] = pct;
                        send(new JSONObject().put("id", id).put("progress", pct));
                    }
                    return true;
                });
                return new JSONObject().put("file", d.file.getAbsolutePath()).put("duration", d.durationSec);
            }
            default:
                throw new IllegalArgumentException("op sconosciuta");
        }
    }

    private static app.stemkitmobile.core.ChordRecognizer recognizer;

    /** chords of an audio file: decoded by ffmpeg to 22.05 kHz mono, then BTC (ChordRecognizer) */
    private static JSONObject chords(long id, String path, String ffmpeg, String model) throws Exception {
        synchronized (PcEngine.class) {
            if (recognizer == null) recognizer = new app.stemkitmobile.core.ChordRecognizer(java.nio.file.Files.readAllBytes(new File(model).toPath()));
        }
        Process p = new ProcessBuilder(ffmpeg, "-v", "error", "-i", path, "-ac", "1", "-ar", "22050", "-f", "f32le", "-")
            .redirectError(ProcessBuilder.Redirect.DISCARD).start();
        byte[] raw = p.getInputStream().readAllBytes();
        p.waitFor();
        java.nio.FloatBuffer fb = java.nio.ByteBuffer.wrap(raw).order(java.nio.ByteOrder.LITTLE_ENDIAN).asFloatBuffer();
        float[] mono = new float[fb.remaining()];
        fb.get(mono);
        if (mono.length == 0) throw new IllegalStateException("audio non leggibile");
        long[] last = {-1};
        java.util.List<app.stemkitmobile.core.ChordRecognizer.Segment> segs;
        synchronized (PcEngine.class) {
            segs = recognizer.recognize(mono, f -> {
                long pct = Math.round(f * 100);
                if (pct != last[0]) {
                    last[0] = pct;
                    send(new JSONObject().put("id", id).put("progress", pct));
                }
            });
        }
        return segmentsJson(segs, mono.length / (double) app.stemkitmobile.core.ChordRecognizer.SR);
    }

    static JSONObject segmentsJson(java.util.List<app.stemkitmobile.core.ChordRecognizer.Segment> segs, double duration) {
        org.json.JSONArray a = new org.json.JSONArray();
        for (app.stemkitmobile.core.ChordRecognizer.Segment s : segs) {
            a.put(new org.json.JSONArray().put(Math.round(s.start * 100) / 100.0).put(app.stemkitmobile.core.ChordRecognizer.label(s.chord))
                .put(Math.round(s.confidence * 100) / 100.0));
        }
        return new JSONObject().put("version", 1).put("duration", duration).put("segments", a);
    }

    private static void send(JSONObject o) {
        synchronized (OUT) {
            OUT.println(o.toString());
        }
    }
}
