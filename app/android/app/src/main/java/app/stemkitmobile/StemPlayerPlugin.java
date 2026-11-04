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
        prefetchWhisper();
        // notification / lock-screen buttons work natively, even with the app asleep
        PlaybackService.remote = action -> {
            if ("next".equals(action)) engine.next();
            else engine.prev();
        };
    }

    /**
     * Whisper (podcast transcripts, timing for lyrics without it) is fetched once in the
     * background after installing, on Wi-Fi, so the words are there when you need them;
     * on mobile data it waits for a later start (or comes when first needed).
     */
    private void prefetchWhisper() {
        Thread t = new Thread(() -> {
            try {
                android.net.ConnectivityManager cm = (android.net.ConnectivityManager) getContext().getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
                if (cm == null || cm.isActiveNetworkMetered()) return;
                app.stemkitmobile.core.ModelStore.whisper(new File(getContext().getFilesDir(), "models"), p -> {});
            } catch (Exception e) {
                android.util.Log.w("StemKitPlayer", "whisper prefetch", e);
            }
        }, "stemkit-whisper-prefetch");
        t.setPriority(Thread.MIN_PRIORITY);
        t.start();
    }

    @Override
    protected void handleOnDestroy() {
        engine.removeListener(this);
    }

    // ------------------------------------------------------------ Jam (Jam.java)

    private final java.util.concurrent.ExecutorService jamPool = java.util.concurrent.Executors.newCachedThreadPool();

    private Jam jam() {
        Jam j = Jam.get(getContext());
        j.setListener(this::onEvent);
        return j;
    }

    @PluginMethod
    public void jamStart(PluginCall call) {
        jamPool.execute(() -> {
            try {
                call.resolve(JSObject.fromJSONObject(jam().start(call.getString("host", ""), call.getBoolean("allowControl", true))));
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void jamStop(PluginCall call) {
        jamPool.execute(() -> {
            jam().stop();
            call.resolve();
        });
    }

    @PluginMethod
    public void jamState(PluginCall call) {
        jamPool.execute(() -> {
            try {
                call.resolve(JSObject.fromJSONObject(jam().state(null)));
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    /** the host's own song ("Metti in coda" during a Jam) */
    @PluginMethod
    public void jamAdd(PluginCall call) {
        JSONObject s = call.getObject("spec");
        if (s == null) {
            call.reject("spec mancante");
            return;
        }
        jamPool.execute(() -> {
            jam().addSpec(spec(s), call.getString("by", ""));
            call.resolve();
        });
    }

    @PluginMethod
    public void jamEdit(PluginCall call) {
        jamPool.execute(() -> {
            JSObject r = new JSObject();
            r.put("ok", jam().edit(call.getString("key", ""), call.getString("action", ""), null));
            call.resolve(r);
        });
    }

    @PluginMethod
    public void jamSetControl(PluginCall call) {
        jam().setAllowControl(call.getBoolean("allowControl", true));
        call.resolve();
    }

    /** Jams nearby (other phones): 'jamFound' / 'jamLost' events on the "player" channel */
    @PluginMethod
    public void jamDiscover(PluginCall call) {
        jam().discover(call.getBoolean("on", true), this::onEvent);
        call.resolve();
    }

    /** a call to someone else's Jam: {base: its link, path: "/api/state?k=…", method, body} */
    @PluginMethod
    public void jamRequest(PluginCall call) {
        jamPool.execute(() -> {
            try {
                String text = Jam.request(call.getString("base", ""), call.getString("path", "/"), call.getString("method", "GET"), call.getString("body"));
                JSObject r = new JSObject();
                r.put("text", text);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
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
        else if (orig != null && orig.startsWith("https://")) s.original = orig; // a podcast episode, from its own server
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
        s.name = data.optString("name", "");
        s.artist = data.optString("artist", "");
        String cover = data.optString("cover", "");
        File coverFile = cover.isEmpty() || cover.contains("..") ? null : new File(base, cover);
        String art = data.optString("art", "");
        if (coverFile != null && coverFile.isFile()) s.art = coverFile.getAbsolutePath();
        else if (art.startsWith("https://")) s.art = art;
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
        engine.setSleep(call.getDouble("minutes", 0.0), call.getDouble("fade", 0.0), Boolean.TRUE.equals(call.getBoolean("finishSong", false)));
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

    /** When each line of unsynced lyrics is sung (core/LyricsAligner): the vocal track (or the song) through Whisper. */
    @PluginMethod
    public void alignLyrics(PluginCall call) {
        String songId = call.getString("songId", "");
        String ref = call.getString("path", "");
        try {
            if (ref.contains("..")) throw new IllegalArgumentException("percorso non valido");
            org.json.JSONArray a = call.getArray("lines", new com.getcapacitor.JSArray());
            List<String> lines = new ArrayList<>();
            for (int i = 0; i < a.length(); i++) lines.add(a.getString(i));
            meter.execute(() -> {
                try {
                    File models = app.stemkitmobile.core.ModelStore.whisper(new File(getContext().getFilesDir(), "models"),
                        f -> alignProgress(songId, Math.round(f * 25), true));
                    String path = ref.startsWith("stream:") ? StreamProxy.ensureCached(ref.substring(7)).getAbsolutePath()
                        : new File(getContext().getFilesDir(), ref).getAbsolutePath();
                    alignProgress(songId, 27, false);
                    float[] y = app.stemkitmobile.core.Whisper.to16k(Engine.decodeMono22k(new String[] {path}));
                    double[] t = app.stemkitmobile.core.LyricsAligner.align(y, lines, models,
                        f -> alignProgress(songId, 30 + Math.round(f * 70), false));
                    JSObject r = new JSObject();
                    org.json.JSONArray out = new org.json.JSONArray();
                    for (double x : t) out.put(Math.round(x * 100) / 100.0);
                    r.put("times", new com.getcapacitor.JSArray(out.toString()));
                    call.resolve(r);
                } catch (Throwable e) {
                    call.reject("Allineamento del testo non riuscito: " + e.getMessage());
                }
            });
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /**
     * Podcast transcript, 30 s at a time from {@code from} (s): {lang, segments: [{a, b, text}], next}.
     * lang empty: Whisper tells the language (and says it back).
     */
    @PluginMethod
    public void transcribe(PluginCall call) {
        String songId = call.getString("songId", "");
        String ref = call.getString("path", "");
        double from = call.getDouble("from", 0.0);
        String lang = call.getString("lang", "");
        if (ref.contains("..")) {
            call.reject("percorso non valido");
            return;
        }
        transcriber.execute(() -> {
            try {
                File models = app.stemkitmobile.core.ModelStore.whisper(new File(getContext().getFilesDir(), "models"),
                    f -> alignProgress(songId, Math.round(f * 100), true));
                String path = ref.startsWith("https://") ? ref : new File(getContext().getFilesDir(), ref).getAbsolutePath();
                float[] y = Engine.decodeRange16k(path, from, 30);
                app.stemkitmobile.core.Whisper w = app.stemkitmobile.core.LyricsAligner.whisper(models);
                String language = lang.isEmpty() ? w.detect(y) : lang;
                List<app.stemkitmobile.core.Whisper.Segment> segs = new ArrayList<>();
                double next = y.length < 16000 ? from + 30 : w.segments(y, language, from, segs);
                org.json.JSONArray out = new org.json.JSONArray();
                for (app.stemkitmobile.core.Whisper.Segment s : segs) {
                    out.put(new JSONObject().put("a", Math.round(s.a * 100) / 100.0).put("b", Math.round(s.b * 100) / 100.0).put("text", s.text));
                }
                JSObject r = new JSObject();
                r.put("lang", language);
                r.put("segments", new com.getcapacitor.JSArray(out.toString()));
                r.put("next", next);
                r.put("ended", y.length < 16000 * 29);
                call.resolve(r);
            } catch (Throwable e) {
                call.reject("Trascrizione non riuscita: " + e.getMessage());
            }
        });
    }

    /** lines in another language (core/Translate) */
    @PluginMethod
    public void translate(PluginCall call) {
        String to = call.getString("to", "en");
        boolean skipSame = Boolean.TRUE.equals(call.getBoolean("skipSame", false));
        try {
            org.json.JSONArray a = call.getArray("texts", new com.getcapacitor.JSArray());
            List<String> in = new ArrayList<>();
            for (int i = 0; i < a.length(); i++) in.add(a.getString(i));
            translator.execute(() -> { // its own thread: never behind a transcription
                try {
                    JSObject r = new JSObject();
                    r.put("texts", new com.getcapacitor.JSArray(new org.json.JSONArray(app.stemkitmobile.core.Translate.lines(in, to, skipSame)).toString()));
                    call.resolve(r);
                } catch (Throwable e) {
                    call.reject("Traduzione non riuscita: " + e.getMessage());
                }
            });
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    private final java.util.concurrent.ExecutorService transcriber = java.util.concurrent.Executors.newSingleThreadExecutor();
    private final java.util.concurrent.ExecutorService translator = java.util.concurrent.Executors.newSingleThreadExecutor();

    private void alignProgress(String songId, int pct, boolean downloading) {
        JSObject e = new JSObject();
        e.put("songId", songId);
        e.put("pct", pct);
        e.put("downloading", downloading);
        notifyListeners("align", e);
    }

    private app.stemkitmobile.core.Rhythm rhythm;

    /** beats and bars of a song (core/Rhythm): {beats: [s], meter: [beats per bar], pos: [place in the bar]} */
    @PluginMethod
    public void rhythm(PluginCall call) {
        String songId = call.getString("songId", "");
        try {
            org.json.JSONArray a = call.getArray("paths", new com.getcapacitor.JSArray());
            String[] paths = new String[a.length()];
            for (int i = 0; i < paths.length; i++) {
                String p = a.getString(i);
                if (p.contains("..")) throw new IllegalArgumentException("percorso non valido");
                paths[i] = p.startsWith("stream:") || p.startsWith("https://") ? p : new File(getContext().getFilesDir(), p).getAbsolutePath();
            }
            meter.execute(() -> {
                try {
                    File models = app.stemkitmobile.core.ModelStore.rhythm(new File(getContext().getFilesDir(), "models"),
                        f -> rhythmProgress(songId, Math.round(f * 10)));
                    for (int i = 0; i < paths.length; i++) {
                        if (paths[i].startsWith("stream:")) paths[i] = StreamProxy.ensureCached(paths[i].substring(7)).getAbsolutePath();
                    }
                    rhythmProgress(songId, 12);
                    float[] mono = Engine.decodeMono22k(paths);
                    synchronized (this) {
                        if (rhythm == null) rhythm = new app.stemkitmobile.core.Rhythm(models, 4);
                    }
                    app.stemkitmobile.core.Rhythm.Result r;
                    synchronized (this) {
                        r = rhythm.analyse(mono, f -> rhythmProgress(songId, 15 + Math.round(f * 85)));
                    }
                    org.json.JSONArray b = new org.json.JSONArray(), m = new org.json.JSONArray(), p = new org.json.JSONArray();
                    for (int i = 0; i < r.beats.length; i++) {
                        b.put(Math.round(r.beats[i] * 1000) / 1000.0);
                        m.put(r.meter[i]);
                        p.put(r.pos[i]);
                    }
                    JSObject out = new JSObject();
                    out.put("version", 1);
                    out.put("beats", new com.getcapacitor.JSArray(b.toString()));
                    out.put("meter", new com.getcapacitor.JSArray(m.toString()));
                    out.put("pos", new com.getcapacitor.JSArray(p.toString()));
                    call.resolve(out);
                } catch (Throwable e) {
                    call.reject("Analisi del ritmo non riuscita: " + e.getMessage());
                }
            });
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    private void rhythmProgress(String songId, int pct) {
        JSObject e = new JSObject();
        e.put("songId", songId);
        e.put("pct", pct);
        notifyListeners("rhythm", e);
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
