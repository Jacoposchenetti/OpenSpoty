package app.stemkitmobile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

import app.stemkitmobile.audio.Engine;

/** JS side: src/lib/player.ts. Paths are relative to the app's data folder. */
@CapacitorPlugin(name = "StemPlayer")
public class StemPlayerPlugin extends Plugin implements Engine.Listener {
    private Engine engine;

    @Override
    public void load() {
        engine = Engine.get(getContext());
        engine.addListener(this);
        StreamProxy.start(getContext().getCacheDir());
        // notification / lock-screen buttons work natively, even with the app asleep
        PlaybackService.remote = action -> {
            if ("next".equals(action)) engine.next();
            else engine.prev();
        };
    }

    @Override
    protected void handleOnDestroy() {
        engine.removeListener(this);
    }

    @Override
    public void onEvent(JSONObject e) {
        try {
            notifyListeners("player", JSObject.fromJSONObject(e));
        } catch (Exception ignored) {
        }
    }

    private Engine.Spec spec(PluginCall call) {
        return spec(call.getData());
    }

    private Engine.Spec spec(JSONObject data) {
        return specOf(getContext().getFilesDir(), data);
    }

    /** a song as the JS side describes it (lib/player.ts PlayerSpec); also used by the alarm clock */
    static Engine.Spec specOf(File base, JSONObject data) {
        Engine.Spec s = new Engine.Spec();
        s.songId = data.optString("songId", "");
        s.title = data.optString("title", "");
        String orig = data.isNull("original") ? null : data.optString("original", null);
        if (orig != null && orig.matches("stream:[\\w-]{11}")) s.original = StreamProxy.url(orig.substring(7)); // played from YouTube
        else if (orig != null && !orig.isEmpty() && !orig.contains("..")) s.original = new File(base, orig).getAbsolutePath();
        JSONObject stems = data.optJSONObject("stems");
        if (stems == null) stems = new JSONObject();
        List<String> ids = new ArrayList<>(), paths = new ArrayList<>();
        for (Iterator<String> it = stems.keys(); it.hasNext(); ) {
            String id = it.next();
            String p = stems.optString(id, "");
            if (p.isEmpty() || p.contains("..")) continue;
            ids.add(id);
            paths.add(new File(base, p).getAbsolutePath());
        }
        s.stemIds = ids.toArray(new String[0]);
        s.stemPaths = paths.toArray(new String[0]);
        s.offset = data.has("offset") && !data.isNull("offset") ? data.optInt("offset") : null;
        s.startAt = data.optDouble("startAt", 0.0);
        s.durationHint = data.optDouble("duration", 0.0);
        s.gainDb = data.optDouble("gainDb", 0.0);
        s.bpm = data.optDouble("bpm", 0.0);
        s.countIn = data.optBoolean("countIn", false);
        s.mix = data.optJSONObject("mix") != null ? data.optJSONObject("mix") : new JSONObject();
        return s;
    }

    @PluginMethod
    public void setUpcoming(PluginCall call) {
        try {
            List<Engine.Spec> next = new ArrayList<>();
            org.json.JSONArray a = call.getArray("next", new com.getcapacitor.JSArray());
            for (int i = 0; i < a.length(); i++) next.add(spec(a.getJSONObject(i)));
            JSONObject p = call.getObject("previous");
            engine.setUpcoming(next, p != null && p.has("songId") ? spec(p) : null);
            engine.setAutoAdvance(call.getBoolean("autoAdvance", true));
            engine.setRepeatOne(call.getBoolean("repeatOne", false));
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void setCountIn(PluginCall call) {
        engine.setCountIn(call.getInt("beats", 0));
        call.resolve();
    }

    @PluginMethod
    public void setBpm(PluginCall call) {
        engine.setBpm(call.getString("songId", ""), call.getDouble("bpm", 0.0));
        call.resolve();
    }

    @PluginMethod
    public void setSleep(PluginCall call) {
        engine.setSleep(call.getDouble("minutes", 0.0));
        call.resolve();
    }

    @PluginMethod
    public void detectBpm(PluginCall call) {
        String p = call.getString("path", "");
        if (p.contains("..")) {
            call.reject("percorso non valido");
            return;
        }
        String abs = new File(getContext().getFilesDir(), p).getAbsolutePath();
        meter.execute(() -> {
            try {
                JSObject r = new JSObject();
                double b = Engine.detectBpm(abs);
                r.put("bpm", b > 0 ? b : JSONObject.NULL);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    private app.stemkitmobile.core.ChordRecognizer chords;

    /** Chords of a song (its original, or its stems summed): [[seconds, "A:min7", confidence], ...] */
    @PluginMethod
    public void chords(PluginCall call) {
        String songId = call.getString("songId", "");
        try {
            org.json.JSONArray a = call.getArray("paths", new com.getcapacitor.JSArray());
            String[] paths = new String[a.length()];
            for (int i = 0; i < paths.length; i++) {
                String p = a.getString(i);
                if (p.contains("..")) throw new IllegalArgumentException("percorso non valido");
                paths[i] = p.startsWith("stream:") ? p : new File(getContext().getFilesDir(), p).getAbsolutePath();
            }
            meter.execute(() -> {
                try {
                    for (int i = 0; i < paths.length; i++) {
                        // a streamed song: the whole of it from the cache (downloaded now if needed)
                        if (paths[i].startsWith("stream:")) paths[i] = StreamProxy.ensureCached(paths[i].substring(7)).getAbsolutePath();
                    }
                    progress(songId, 2);
                    float[] mono = Engine.decodeMono22k(paths);
                    progress(songId, 10);
                    synchronized (this) {
                        if (chords == null) {
                            try (java.io.InputStream in = getContext().getAssets().open("models/btc_voca.onnx")) {
                                chords = new app.stemkitmobile.core.ChordRecognizer(readFully(in));
                            }
                        }
                    }
                    java.util.List<app.stemkitmobile.core.ChordRecognizer.Segment> segs;
                    synchronized (this) {
                        segs = chords.recognize(mono, f -> progress(songId, 10 + Math.round(f * 90)));
                    }
                    org.json.JSONArray out = new org.json.JSONArray();
                    for (app.stemkitmobile.core.ChordRecognizer.Segment s : segs) {
                        out.put(new org.json.JSONArray().put(Math.round(s.start * 100) / 100.0)
                            .put(app.stemkitmobile.core.ChordRecognizer.label(s.chord)).put(Math.round(s.confidence * 100) / 100.0));
                    }
                    JSObject r = new JSObject();
                    r.put("version", 1);
                    r.put("duration", mono.length / (double) app.stemkitmobile.core.ChordRecognizer.SR);
                    r.put("segments", new com.getcapacitor.JSArray(out.toString()));
                    call.resolve(r);
                } catch (Exception e) {
                    call.reject("Riconoscimento accordi non riuscito: " + e.getMessage());
                }
            });
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    private int lastPct = -1;

    private void progress(String songId, int pct) {
        if (pct == lastPct) return;
        lastPct = pct;
        JSObject e = new JSObject();
        e.put("songId", songId);
        e.put("pct", pct);
        notifyListeners("chords", e);
    }

    private static byte[] readFully(java.io.InputStream in) throws java.io.IOException {
        java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[1 << 16];
        int n;
        while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
        return b.toByteArray();
    }

    @PluginMethod
    public void setGain(PluginCall call) {
        engine.setGainDb(call.getDouble("db", 0.0));
        call.resolve();
    }

    private final java.util.concurrent.ExecutorService meter = java.util.concurrent.Executors.newSingleThreadExecutor();

    /** Integrated loudness of a song (original, or its stems summed). Slow-ish: runs on its own thread. */
    @PluginMethod
    public void measureLoudness(PluginCall call) {
        try {
            org.json.JSONArray a = call.getArray("paths", new com.getcapacitor.JSArray());
            String[] paths = new String[a.length()];
            for (int i = 0; i < paths.length; i++) {
                String p = a.getString(i);
                if (p.contains("..")) throw new IllegalArgumentException("percorso non valido");
                if (p.startsWith("stream:")) {
                    // a streamed song is measured once it is fully in the cache (after its first play)
                    File c = StreamProxy.cachedFile(p.substring(7));
                    if (c == null) {
                        JSObject r = new JSObject();
                        r.put("lufs", JSONObject.NULL);
                        r.put("notCached", true);
                        call.resolve(r);
                        return;
                    }
                    paths[i] = c.getAbsolutePath();
                } else {
                    paths[i] = new File(getContext().getFilesDir(), p).getAbsolutePath();
                }
            }
            meter.execute(() -> {
                try {
                    double lufs = Engine.measureLoudness(paths);
                    JSObject r = new JSObject();
                    r.put("lufs", Double.isNaN(lufs) ? JSONObject.NULL : lufs);
                    call.resolve(r);
                } catch (Exception e) {
                    call.reject(e.getMessage());
                }
            });
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void next(PluginCall call) {
        PlaybackService.start(getContext());
        engine.next();
        call.resolve();
    }

    @PluginMethod
    public void prev(PluginCall call) {
        engine.prev();
        call.resolve();
    }

    @PluginMethod
    public void load(PluginCall call) {
        Engine.Spec s = spec(call);
        boolean autoplay = call.getBoolean("autoplay", true);
        PlaybackService.title = s.title;
        if (autoplay) PlaybackService.start(getContext());
        engine.load(s, autoplay);
        call.resolve();
    }

    @PluginMethod
    public void preload(PluginCall call) {
        engine.preload(spec(call));
        call.resolve();
    }

    @PluginMethod
    public void play(PluginCall call) {
        PlaybackService.start(getContext());
        engine.play();
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        engine.pause();
        call.resolve();
    }

    @PluginMethod
    public void seek(PluginCall call) {
        engine.seek(call.getDouble("t", 0.0));
        call.resolve();
    }

    @PluginMethod
    public void setMix(PluginCall call) {
        engine.setMix(call.getObject("mix", new JSObject()));
        call.resolve();
    }

    @PluginMethod
    public void setLoop(PluginCall call) {
        engine.setLoop(call.getDouble("a", -1.0), call.getDouble("b", -1.0));
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        engine.stop();
        call.resolve();
    }

    @PluginMethod
    public void state(PluginCall call) {
        try {
            call.resolve(JSObject.fromJSONObject(engine.state()));
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }
}
