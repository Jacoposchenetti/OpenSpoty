package app.stemkitmobile.audio;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import app.stemkitmobile.core.Bpm;
import app.stemkitmobile.core.Limiter;
import app.stemkitmobile.core.Loudness;
import app.stemkitmobile.core.OffsetFinder;

/**
 * Native playback engine. One song = a "deck": the original file and the
 * stem files, all streamed and kept in lockstep. When the mix is neutral
 * (nothing muted or soloed, every volume at 100%) the original is heard
 * (better quality: no separation artifacts); otherwise the stems, mixed with
 * their gains. Switching is a 46 ms crossfade at the exact same position.
 * The next song can be opened in advance so it starts instantly.
 */
public final class Engine {
    private static final String TAG = "StemKitEngine";
    public static final int RATE = 44100;
    private static final int BLOCK = 1024;
    private static final int XFADE = 2048;
    private static final int PREBUFFER = RATE / 10; // 100 ms before starting
    private static final double RING_SECONDS = 5;
    private static final int LOOP_CACHE = 2 * RATE;

    public interface Listener {
        void onEvent(JSONObject e);
    }

    /** What to play (paths are absolute). */
    public static final class Spec {
        public String songId = "", title = "";
        public String original; // may be null
        public String[] stemIds = new String[0];
        public String[] stemPaths = new String[0];
        public Integer offset; // frames the stems lag the original; null = unknown
        public double startAt;
        public JSONObject mix;
        public double durationHint;
        public double gainDb; // loudness normalization
        public double bpm; // for the count-in (0 = unknown)
        public boolean countIn; // start with "1, 2, 3, 4"

        boolean sameSongAs(Spec o) {
            return o != null && songId.equals(o.songId) && java.util.Objects.equals(original, o.original)
                && java.util.Arrays.equals(stemPaths, o.stemPaths);
        }
    }

    private static final class Deck {
        final Spec spec;
        FrameSource original;
        FrameSource[] stems = new FrameSource[0];
        int offset;
        boolean offsetKnown;
        long durationFrames;
        // pending realignment per source: >0 = drop frames, <0 = insert silence
        // (offset found after loading, or a decoder that fell behind)
        int origAdj;
        int[] stemAdj = new int[0];

        Deck(Spec spec) {
            this.spec = spec;
        }

        void seek(long frame) {
            if (original != null) original.seek(frame);
            long sf = frame + offset;
            for (FrameSource s : stems) s.seek(Math.max(0, sf));
            stemAdj = new int[stems.length];
            java.util.Arrays.fill(stemAdj, sf < 0 ? (int) sf : 0); // stems start later than frame 0
            origAdj = 0;
        }

        void close() {
            if (original != null) original.close();
            for (FrameSource s : stems) s.close();
        }
    }

    private static Engine instance;

    public static synchronized Engine get(Context ctx) {
        if (instance == null) instance = new Engine(ctx.getApplicationContext());
        return instance;
    }

    private final Object lock = new Object();
    private final List<Listener> listeners = new ArrayList<>();
    private final ExecutorService loader = Executors.newSingleThreadExecutor();
    private final ExecutorService helper = Executors.newSingleThreadExecutor();
    private final ExecutorService opener = Executors.newFixedThreadPool(8);
    private final Limiter limiter = new Limiter(RATE, -1f, 2f, 120f);
    private AudioTrack track;
    private Thread renderThread;

    // guarded by lock
    private Deck deck, preloaded;
    private Spec preloadSpec;
    private boolean playing, loading;
    private long pos; // song frame of the next frame to render
    private int loadToken;
    private float[] stemTarget = new float[0], stemCur = new float[0];
    private float master = 1f, masterCur = 1f;
    private boolean useOriginal;
    private float speed = 1f, pitchSemis = 0f; // per song, from its mix
    private float normGain = 1f, normGainCur = 1f; // "volume uniforme"
    private float origW = 1f;
    private long loopA = -1, loopB = -1;
    private float[][] cacheStems; // loop start, pre-decoded
    private float[] cacheOrig;
    private int cacheLen, cacheIdx = -1; // cacheIdx >= 0 while playing from the cache
    private int cacheToken;
    private String error;
    // {written, songFrame, rate x 1e6}: from output frame `written` on, the song advances by `rate` per frame
    private final ArrayDeque<long[]> markers = new ArrayDeque<>();
    private long written;
    // speed / key (render thread): Signalsmith Stretch, formants kept; bypassed at 100% and key 0
    private Stretch stretch;
    private boolean stretching;
    private float stretchSpeed = 1f, stretchPitch = 0f;
    private double stretchAcc;
    private float[] stretchOut = new float[0];
    private volatile boolean stretchDirty;
    private long headBase;
    private boolean primed = true; // false right after a seek/load: wait for all sources once

    private Engine(Context ctx) {}

    public void addListener(Listener l) {
        synchronized (listeners) {
            if (!listeners.contains(l)) listeners.add(l);
        }
    }

    public void removeListener(Listener l) {
        synchronized (listeners) {
            listeners.remove(l);
        }
    }

    private void emit(JSONObject e) {
        Listener[] ls;
        synchronized (listeners) {
            ls = listeners.toArray(new Listener[0]);
        }
        for (Listener l : ls) {
            try {
                l.onEvent(e);
            } catch (Exception ex) {
                Log.w(TAG, "listener", ex);
            }
        }
    }

    // ------------------------------------------------------------ public API

    public void load(Spec spec, boolean autoplay) {
        final int token;
        synchronized (lock) {
            currentSpec = spec;
            token = ++loadToken;
            loading = true;
            error = null;
            if (playing && track != null) track.pause();
            playing = false;
        }
        emitState();
        loader.execute(() -> doLoad(spec, autoplay, token));
    }

    // ------------------------------------------------------------ playlist (works with the app in background)

    private final List<Spec> upcoming = new ArrayList<>();
    private Spec prevSpec, currentSpec;
    private boolean autoAdvance = true;
    private boolean repeatOne;

    // count-in: clicks rendered before the song audio
    private int countInBeats; // 0 = off
    private double countInBpm;
    private int clickRemaining = 0; // frames of count-in still to render
    private int clickPhase = 0;
    private int clickBeatFrames = 1;

    // sleep timer
    private final java.util.concurrent.ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
    private java.util.concurrent.ScheduledFuture<?> sleepTask;
    private boolean sleepAtEnd;
    private long sleepAt; // wall clock ms, 0 = none

    /** tempo of the current song changed (detected later, or tapped by hand) */
    public void setBpm(String songId, double bpm) {
        synchronized (lock) {
            if (deck != null && deck.spec.songId.equals(songId)) countInBpm = bpm;
        }
    }

    public void setCountIn(int beats) {
        synchronized (lock) {
            countInBeats = Math.max(0, Math.min(8, beats));
        }
    }

    /** Pause after {@code minutes}, or at the end of the current song (minutes < 0), or cancel (0). */
    public void setSleep(double minutes) {
        synchronized (lock) {
            if (sleepTask != null) sleepTask.cancel(false);
            sleepTask = null;
            sleepAtEnd = minutes < 0;
            sleepAt = minutes > 0 ? System.currentTimeMillis() + Math.round(minutes * 60_000) : 0;
            if (minutes > 0) {
                sleepTask = timer.schedule(() -> {
                    synchronized (lock) {
                        sleepAt = 0;
                    }
                    pause();
                }, Math.round(minutes * 60_000), java.util.concurrent.TimeUnit.MILLISECONDS);
            }
        }
        emitState();
    }

    /** arm the "1, 2, 3, 4" if wanted and the tempo is known */
    private void armCountInLocked(boolean wanted) {
        clickRemaining = 0;
        if (!wanted || countInBeats <= 0 || countInBpm < 30 || countInBpm > 300) return;
        clickBeatFrames = (int) Math.round(RATE * 60.0 / countInBpm);
        clickRemaining = clickBeatFrames * countInBeats;
        clickPhase = 0;
    }

    /** Integrated tempo of a song from (preferably) its drums stem: first 75 s. */
    public static double detectBpm(String path) throws Exception {
        FrameSource s = openSource(path);
        try {
            Bpm b = new Bpm(RATE);
            float[] buf = new float[2 * 4096];
            long total = 0, max = 75L * RATE;
            long end = System.currentTimeMillis() + 60_000;
            while (total < max && System.currentTimeMillis() < end) {
                int n = s.read(buf, 0, 4096);
                if (n == 0) {
                    if (s.ended()) break;
                    Thread.sleep(1);
                    continue;
                }
                b.add(buf, n);
                total += n;
            }
            return b.bpm();
        } finally {
            s.close();
        }
    }

    public void setRepeatOne(boolean on) {
        synchronized (lock) {
            repeatOne = on;
        }
    }

    /** What plays after the current song (queue first, then the list) and before it. */
    public void setUpcoming(List<Spec> next, Spec previous) {
        synchronized (lock) {
            upcoming.clear();
            upcoming.addAll(next);
            prevSpec = previous;
        }
        if (!next.isEmpty()) preload(next.get(0));
    }

    public void setAutoAdvance(boolean on) {
        synchronized (lock) {
            autoAdvance = on;
        }
    }

    /** Next song, natively: also from the notification / lock screen, also with the app asleep. */
    public void next() {
        Spec s;
        synchronized (lock) {
            if (upcoming.isEmpty()) return;
            s = upcoming.remove(0);
            prevSpec = currentSpec;
        }
        s.startAt = 0;
        load(s, true);
        emitAdvanced(s.songId, "next");
        Spec after;
        synchronized (lock) {
            after = upcoming.isEmpty() ? null : upcoming.get(0);
        }
        if (after != null) preload(after);
    }

    /** Back to the start of the song, or (in its first 3 seconds) the previous song. */
    public void prev() {
        Spec s;
        synchronized (lock) {
            boolean early = reportedPosLocked() < 3 * RATE;
            if (!early || prevSpec == null) s = null;
            else {
                s = prevSpec;
                if (currentSpec != null) upcoming.add(0, currentSpec);
                prevSpec = null;
            }
        }
        if (s == null) {
            seek(0);
            return;
        }
        s.startAt = 0;
        load(s, true);
        emitAdvanced(s.songId, "prev");
    }

    private void emitAdvanced(String songId, String dir) {
        try {
            JSONObject e = new JSONObject();
            e.put("type", "advanced");
            e.put("songId", songId);
            e.put("dir", dir);
            emit(e);
        } catch (Exception ignored) {
        }
    }

    public void preload(Spec spec) {
        loader.execute(() -> {
            synchronized (lock) {
                if (spec.sameSongAs(preloadSpec) || (deck != null && spec.sameSongAs(deck.spec))) return;
            }
            Deck d = null;
            try {
                d = openDeck(spec);
                d.seek(0);
            } catch (Exception e) {
                Log.w(TAG, "preload " + spec.songId, e);
                if (d != null) d.close();
                return;
            }
            Deck old;
            synchronized (lock) {
                old = preloaded;
                preloaded = d;
                preloadSpec = spec;
            }
            if (old != null) old.close();
        });
    }

    public void play() {
        synchronized (lock) {
            if (deck == null || loading) return;
            ensureTrack();
            if (!playing) armCountInLocked(true);
            playing = true;
            track.play();
            lock.notifyAll();
        }
        emitState();
    }

    public void pause() {
        synchronized (lock) {
            if (!playing) return;
            playing = false;
            if (track != null) track.pause();
        }
        emitState();
    }

    public boolean isPlaying() {
        synchronized (lock) {
            return playing;
        }
    }

    public void seek(double seconds) {
        synchronized (lock) {
            if (deck == null) return;
            long f = Math.max(0, Math.round(seconds * RATE));
            if (deck.durationFrames > 0) f = Math.min(f, deck.durationFrames - 1);
            deck.seek(f);
            pos = f;
            cacheIdx = -1;
            restartTrackLocked(f);
        }
        emitState();
    }

    public void setMix(JSONObject mix) {
        synchronized (lock) {
            if (deck == null) return;
            applyMixLocked(mix, false);
        }
        emitState();
    }

    public void setLoop(double a, double b) {
        synchronized (lock) {
            if (deck == null) return;
            if (a < 0 || b <= a + 0.2) {
                loopA = loopB = -1;
                cacheIdx = -1;
                cacheOrig = null;
                cacheStems = null;
                emitStateLater();
                return;
            }
            loopA = Math.round(a * RATE);
            loopB = Math.round(b * RATE);
            cacheOrig = null;
            cacheStems = null;
            cacheIdx = -1;
            final int token = ++cacheToken;
            final Deck d = deck;
            final long A = loopA, len = Math.min(LOOP_CACHE, loopB - loopA);
            helper.execute(() -> buildLoopCache(d, A, (int) len, token));
            // if the loop starts after the current point, nothing else to do;
            // if we are past B already, jump now
            if (pos >= loopB) {
                deck.seek(loopA);
                pos = loopA;
                restartTrackLocked(loopA);
            }
        }
        emitState();
    }

    /** Loudness normalization gain of the current song (dB), applied smoothly. */
    public void setGainDb(double db) {
        synchronized (lock) {
            normGain = (float) Math.pow(10, db / 20.0);
        }
    }

    /** Integrated loudness (LUFS) of a song: one file, or the sum of its stems. */
    /** the files summed (a song, or its stems) as 22.05 kHz mono, for chord recognition */
    public static float[] decodeMono22k(String[] paths) throws Exception {
        float[] sum = new float[2 * RATE * 60];
        int frames = 0;
        for (String path : paths) {
            FrameSource s = openSource(path);
            try {
                int pos = 0;
                long end = System.currentTimeMillis() + 120_000;
                float[] buf = new float[2 * 4096];
                while (System.currentTimeMillis() < end) {
                    int n = s.read(buf, 0, 4096);
                    if (n == 0) {
                        if (s.ended()) break;
                        Thread.sleep(1);
                        continue;
                    }
                    if (2 * (pos + n) > sum.length) sum = java.util.Arrays.copyOf(sum, Math.max(sum.length * 3 / 2, 2 * (pos + n)));
                    for (int i = 0; i < 2 * n; i++) sum[2 * pos + i] += buf[i];
                    pos += n;
                }
                frames = Math.max(frames, pos);
            } finally {
                s.close();
            }
        }
        return app.stemkitmobile.core.ChordRecognizer.toMono22k(sum, frames);
    }

    /** a stretch of a file or of a web address (a podcast episode) as 16 kHz mono, for its transcript */
    public static float[] decodeRange16k(String path, double fromSec, double seconds) throws Exception {
        FrameSource s = openSource(path);
        try {
            if (fromSec > 0) s.seek(Math.round(fromSec * RATE));
            int frames = (int) Math.round(seconds * RATE);
            float[] out = new float[2 * frames];
            int got = 0;
            long end = System.currentTimeMillis() + 90_000; // from the network
            while (got < frames && System.currentTimeMillis() < end) {
                int n = s.read(out, got, frames - got);
                got += n;
                if (n == 0) {
                    if (s.ended()) break;
                    Thread.sleep(5);
                }
            }
            return app.stemkitmobile.core.Whisper.to16k(app.stemkitmobile.core.ChordRecognizer.toMono22k(out, got));
        } finally {
            s.close();
        }
    }

    public static double measureLoudness(String[] paths) throws Exception {
        List<FrameSource> src = new ArrayList<>();
        try {
            for (String p : paths) src.add(openSource(p));
            Loudness meter = new Loudness(RATE);
            float[] sum = new float[2 * 4096], tmp = new float[2 * 4096];
            while (true) {
                java.util.Arrays.fill(sum, 0f);
                int most = 0;
                boolean allEnded = true;
                for (FrameSource s : src) {
                    int got = 0;
                    long end = System.currentTimeMillis() + 2000;
                    while (got < 4096 && !s.ended() && System.currentTimeMillis() < end) {
                        int n = s.read(tmp, got, 4096 - got);
                        got += n;
                        if (n == 0) Thread.sleep(1);
                    }
                    for (int i = 0; i < 2 * got; i++) sum[i] += tmp[i];
                    most = Math.max(most, got);
                    allEnded &= s.ended();
                }
                if (most > 0) meter.add(sum, most);
                if (allEnded && most == 0) break;
                if (allEnded && most < 4096) {
                    break;
                }
            }
            return meter.integrated();
        } finally {
            for (FrameSource s : src) s.close();
        }
    }

    public void stop() {
        Deck old;
        synchronized (lock) {
            loadToken++;
            playing = false;
            loading = false;
            if (track != null) {
                track.pause();
                track.flush();
            }
            old = deck;
            deck = null;
        }
        if (old != null) old.close();
        emitState();
    }

    public JSONObject state() {
        synchronized (lock) {
            return stateLocked();
        }
    }

    // ------------------------------------------------------------ loading

    private Deck openDeck(Spec spec) throws Exception {
        Deck d = new Deck(spec);
        // open every file at once: each decoder needs a few ms to report its format
        // (http: YouTube through StreamProxy; https: a podcast episode, straight from its server)
        java.util.concurrent.Future<FrameSource> orig = spec.original != null && (spec.original.startsWith("http://") || spec.original.startsWith("https://") || new File(spec.original).isFile())
            ? opener.submit(() -> openSource(spec.original)) : null;
        List<java.util.concurrent.Future<FrameSource>> st = new ArrayList<>();
        for (String p : spec.stemPaths) st.add(opener.submit(() -> openSource(p)));
        Exception failure = null;
        try {
            if (orig != null) d.original = orig.get();
        } catch (Exception e) {
            failure = e;
        }
        List<FrameSource> opened = new ArrayList<>();
        for (java.util.concurrent.Future<FrameSource> f : st) {
            try {
                opened.add(f.get());
            } catch (Exception e) {
                if (failure == null) failure = e;
            }
        }
        d.stems = opened.toArray(new FrameSource[0]);
        if (failure != null) {
            d.close();
            throw failure instanceof java.util.concurrent.ExecutionException && failure.getCause() instanceof Exception
                ? (Exception) failure.getCause() : failure;
        }
        if (d.original == null && d.stems.length == 0) throw new IllegalStateException("nessun file audio");
        d.offset = spec.offset != null ? spec.offset : 0;
        d.offsetKnown = spec.offset != null || d.original == null || d.stems.length == 0;
        d.durationFrames = Math.round(spec.durationHint * RATE);
        return d;
    }

    private static FrameSource openSource(String path) throws Exception {
        DecoderSource src = new DecoderSource(path, RING_SECONDS);
        if (!src.awaitFormat(4000)) {
            src.close();
            throw new IllegalStateException("formato audio non leggibile");
        }
        return src.rate() == RATE ? src : new ResampledSource(src, RATE);
    }

    private void doLoad(Spec spec, boolean autoplay, int token) {
        Deck d = null;
        try {
            long start = Math.max(0, Math.round(spec.startAt * RATE));
            boolean fresh = true;
            synchronized (lock) {
                if (preloaded != null && spec.sameSongAs(preloadSpec) && start == 0) {
                    d = preloaded; // opened in advance: already buffering from 0
                    preloaded = null;
                    preloadSpec = null;
                    fresh = false;
                    if (spec.offset != null) {
                        d.offset = spec.offset;
                        d.offsetKnown = true;
                    }
                }
            }
            if (d == null) d = openDeck(spec);
            if (fresh) d.seek(start);
            waitBuffered(d, PREBUFFER, 3000, token);
            Deck old;
            synchronized (lock) {
                if (token != loadToken) {
                    d.close();
                    return;
                }
                old = deck;
                deck = d;
                pos = start;
                loopA = loopB = -1;
                cacheIdx = -1;
                cacheOrig = null;
                cacheStems = null;
                applyMixLocked(spec.mix, true);
                normGain = normGainCur = (float) Math.pow(10, spec.gainDb / 20.0);
                countInBpm = spec.bpm;
                armCountInLocked(autoplay && spec.countIn);
                limiter.reset();
                ensureTrack();
                restartTrackLocked(start);
                loading = false;
                playing = autoplay;
                if (playing) track.play();
                lock.notifyAll();
            }
            if (old != null && old != d) old.close();
            emitState();
            if (!d.offsetKnown) detectOffset(d);
        } catch (Exception e) {
            Log.e(TAG, "load " + spec.songId, e);
            if (d != null) d.close();
            synchronized (lock) {
                if (token != loadToken) return;
                loading = false;
                error = e.getMessage() != null ? e.getMessage() : e.toString();
            }
            emitState();
        }
    }

    private void waitBuffered(Deck d, int frames, long timeoutMs, int token) throws InterruptedException {
        long end = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < end) {
            synchronized (lock) {
                if (token != loadToken) return;
            }
            boolean ok = d.original == null || d.original.buffered() >= frames || d.original.ended();
            for (FrameSource s : d.stems) ok &= s.buffered() >= frames || s.ended();
            if (ok) return;
            Thread.sleep(5);
        }
    }

    // ------------------------------------------------------------ mix

    private void applyMixLocked(JSONObject mix, boolean immediate) {
        Deck d = deck;
        int n = d.stems.length;
        if (stemTarget.length != n) {
            stemTarget = new float[n];
            stemCur = new float[n];
        }
        JSONArray muted = mix != null ? mix.optJSONArray("muted") : null;
        JSONArray solo = mix != null ? mix.optJSONArray("solo") : null;
        JSONObject vols = mix != null ? mix.optJSONObject("vols") : null;
        boolean neutral = (muted == null || muted.length() == 0) && (solo == null || solo.length() == 0);
        for (int i = 0; i < n; i++) {
            String id = d.spec.stemIds[i];
            double v = vols != null ? vols.optDouble(id, 1.0) : 1.0;
            if (Math.abs(v - 1.0) > 0.005) neutral = false;
            float g;
            if (solo != null && solo.length() > 0) g = contains(solo, id) ? (float) v : 0f;
            else g = contains(muted, id) ? 0f : (float) v;
            stemTarget[i] = g;
            if (immediate) stemCur[i] = g;
        }
        master = mix != null ? (float) mix.optDouble("master", 1.0) : 1f;
        float sp = mix != null ? (float) mix.optDouble("speed", 1.0) : 1f;
        float pi = mix != null ? (float) mix.optDouble("pitch", 0.0) : 0f;
        sp = Math.max(0.5f, Math.min(1.5f, sp));
        pi = Math.max(-12f, Math.min(12f, pi));
        if (sp != speed || pi != pitchSemis || immediate) {
            speed = sp;
            pitchSemis = pi;
            applyParamsLocked();
        }
        if (immediate) masterCur = master;
        useOriginal = d.original != null && (neutral || n == 0);
        if (immediate) origW = useOriginal ? 1f : 0f;
    }

    private static boolean contains(JSONArray a, String id) {
        if (a == null) return false;
        for (int i = 0; i < a.length(); i++) if (id.equals(a.optString(i))) return true;
        return false;
    }

    // ------------------------------------------------------------ loop cache

    private void buildLoopCache(Deck d, long a, int len, int token) {
        List<FrameSource> tmp = new ArrayList<>();
        try {
            FrameSource o = null;
            if (d.original != null) {
                o = openSource(d.spec.original);
                tmp.add(o);
                o.seek(a);
            }
            FrameSource[] st = new FrameSource[d.stems.length];
            for (int i = 0; i < st.length; i++) {
                st[i] = openSource(d.spec.stemPaths[i]);
                tmp.add(st[i]);
                st[i].seek(Math.max(0, a + d.offset));
            }
            float[] co = o != null ? readBlocking(o, len) : null;
            float[][] cs = new float[st.length][];
            for (int i = 0; i < st.length; i++) cs[i] = readBlocking(st[i], len);
            synchronized (lock) {
                if (token != cacheToken || deck != d) return;
                cacheOrig = co;
                cacheStems = cs;
                cacheLen = len;
            }
        } catch (Exception e) {
            Log.w(TAG, "loop cache", e);
        } finally {
            for (FrameSource s : tmp) s.close();
        }
    }

    private static float[] readBlocking(FrameSource s, int frames) throws InterruptedException {
        float[] out = new float[2 * frames];
        int got = 0;
        long end = System.currentTimeMillis() + 4000;
        while (got < frames && System.currentTimeMillis() < end) {
            int n = s.read(out, got, frames - got);
            got += n;
            if (n == 0) {
                if (s.ended()) break;
                Thread.sleep(3);
            }
        }
        return out;
    }

    // ------------------------------------------------------------ offset detection

    private void detectOffset(Deck d) {
        helper.execute(() -> {
            List<FrameSource> tmp = new ArrayList<>();
            try {
                double dur = d.durationFrames > 0 ? d.durationFrames / (double) RATE : 120;
                long at = Math.round(Math.min(60, Math.max(5, dur * 0.3)) * RATE);
                int len = 3 * RATE;
                FrameSource o = openSource(d.spec.original);
                tmp.add(o);
                o.seek(at);
                float[] os = readBlocking(o, len);
                float[] sum = new float[len];
                for (String p : d.spec.stemPaths) {
                    FrameSource s = openSource(p);
                    tmp.add(s);
                    s.seek(at);
                    float[] b = readBlocking(s, len);
                    for (int i = 0; i < len; i++) sum[i] += b[2 * i] + b[2 * i + 1];
                }
                float[] om = new float[len];
                for (int i = 0; i < len; i++) om[i] = os[2 * i] + os[2 * i + 1];
                OffsetFinder.Result r = OffsetFinder.find(om, sum, 4096);
                int lag = r.confidence >= 0.35 ? r.lag : 0;
                synchronized (lock) {
                    if (deck == d) {
                        int delta = lag - d.offset;
                        // realign only the side that is silent now (inaudible)
                        if (origW >= 0.5f) for (int i = 0; i < d.stemAdj.length; i++) d.stemAdj[i] += delta;
                        else d.origAdj -= delta;
                    }
                    d.offset = lag;
                    d.offsetKnown = true;
                }
                JSONObject e = new JSONObject();
                e.put("type", "offset");
                e.put("songId", d.spec.songId);
                e.put("offset", lag);
                e.put("confidence", r.confidence);
                emit(e);
            } catch (Exception e) {
                Log.w(TAG, "offset detection", e);
            } finally {
                for (FrameSource s : tmp) s.close();
            }
        });
    }

    // ------------------------------------------------------------ render thread

    private void ensureTrack() {
        if (track != null) return;
        AudioFormat fmt = new AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
            .setSampleRate(RATE)
            .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
            .build();
        int min = AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_FLOAT);
        track = new AudioTrack.Builder()
            .setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build())
            .setAudioFormat(fmt)
            .setBufferSizeInBytes(Math.max(min, (RATE / 8) * 8)) // ~125 ms (whole frames): mutes are heard quickly
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build();
        renderThread = new Thread(this::renderLoop, "stemkit-render");
        renderThread.setPriority(Thread.MAX_PRIORITY);
        renderThread.start();
    }

    /** Tempo and key, independently (Android's built-in time-stretcher on the output). */
    private void applyParamsLocked() {
        // applied by the render thread at its next block (stretchBlock)
    }

    /**
     * Speed and key of one mixed block: frames in, about frames / speed out.
     * Signalsmith Stretch keeps the formants, so a voice moved up stays a voice.
     * @return the frames to write (in `buf` or in stretchOut)
     */
    private int stretchBlock(float[] buf, int frames, long blockPos) {
        float sp, pi;
        synchronized (lock) {
            sp = speed;
            pi = pitchSemis;
        }
        boolean active = Math.abs(sp - 1f) > 0.001f || Math.abs(pi) > 0.001f;
        if (active && stretch == null) stretch = new Stretch(RATE);
        if (active != stretching || (active && sp != stretchSpeed)) {
            synchronized (lock) {
                if (active && !stretching) stretchDirty = true;
                stretching = active;
                stretchSpeed = sp;
                markLocked(blockPos);
            }
        }
        if (!active) return frames;
        if (pi != stretchPitch || stretchDirty) {
            stretch.setKey(pi, true);
            stretchPitch = pi;
        }
        if (stretchDirty) {
            stretchDirty = false;
            stretch.reset();
            stretchAcc = 0;
        }
        stretchAcc += frames / (double) sp;
        int outN = (int) stretchAcc;
        stretchAcc -= outN;
        if (stretchOut.length < 2 * outN) stretchOut = new float[2 * outN + 2048];
        if (outN > 0) stretch.process(buf, frames, stretchOut, outN);
        return outN;
    }

    /** Discontinuity (load / seek): drop queued audio, restart the position clock. */
    private void restartTrackLocked(long songFrame) {
        if (track == null) return;
        boolean was = playing;
        track.pause();
        track.flush();
        primed = false;
        written = 0;
        headBase = track.getPlaybackHeadPosition() & 0xFFFFFFFFL;
        markers.clear();
        stretchDirty = true; // a discontinuity: the stretcher starts afresh
        markLocked(songFrame);
        if (was) track.play();
    }

    private long reportedPosLocked() {
        if (track == null || markers.isEmpty()) return pos;
        long head = (track.getPlaybackHeadPosition() & 0xFFFFFFFFL) - headBase;
        long[] m = markers.peekFirst();
        for (long[] x : markers) if (x[0] <= head) m = x;
        return Math.max(0, m[1] + Math.round(Math.max(0, head - m[0]) * (m[2] / 1e6)));
    }

    /** from now on (the next frame written) the song is at songFrame, moving at the current speed */
    private void markLocked(long songFrame) {
        int lat = stretching && stretch != null ? stretch.latency() : 0;
        markers.add(new long[] {written, songFrame - lat, Math.round((stretching ? stretchSpeed : 1f) * 1e6)});
        while (markers.size() > 32) markers.pollFirst();
    }

    private void renderLoop() {
        float[] out = new float[2 * BLOCK];
        float[] o = new float[2 * BLOCK];
        float[] s = new float[2 * BLOCK];
        float[] t = new float[2 * BLOCK];
        long lastTick = 0;
        while (true) {
            Deck d;
            int frames = BLOCK;
            boolean hasO, hasS;
            float[] gFrom, gTo;
            float mFrom, mTo;
            boolean wantOrig;
            int cIdx;
            long blockPos;
            try {
                synchronized (lock) {
                    while (!playing || deck == null) {
                        lock.wait(200);
                        if (System.currentTimeMillis() - lastTick > 500) {
                            lastTick = System.currentTimeMillis();
                            emitTickLater();
                        }
                    }
                    d = deck;
                    if (loopB > loopA && loopA >= 0 && pos < loopB && pos + frames > loopB) frames = (int) (loopB - pos);
                    hasO = d.original != null;
                    hasS = d.stems.length > 0;
                    gFrom = stemCur.clone();
                    gTo = stemTarget.clone();
                    System.arraycopy(stemTarget, 0, stemCur, 0, stemTarget.length);
                    mFrom = masterCur;
                    mTo = master;
                    masterCur = master;
                    wantOrig = useOriginal;
                    cIdx = cacheIdx;
                    blockPos = pos;
                }
                int clicks;
                synchronized (lock) {
                    clicks = clickRemaining;
                }
                if (clicks > 0) {
                    int n = Math.min(frames, clicks);
                    renderClicks(out, n);
                    track.write(out, 0, 2 * n, AudioTrack.WRITE_BLOCKING);
                    synchronized (lock) {
                        clickRemaining = Math.max(0, clickRemaining - n);
                        written += n;
                        markLocked(pos); // the song clock waits for the count-in
                    }
                    continue;
                }
                if (!primed) {
                    // after a seek every decoder restarts: wait for all of them together
                    long end = System.currentTimeMillis() + 600;
                    while (System.currentTimeMillis() < end) {
                        boolean ok = !hasO || d.original.buffered() >= frames || d.original.ended();
                        for (FrameSource x : d.stems) ok &= x.buffered() >= frames || x.ended();
                        if (ok) break;
                        Thread.sleep(2);
                    }
                    synchronized (lock) {
                        if (pos == blockPos) primed = true;
                    }
                }
                java.util.Arrays.fill(out, 0, 2 * frames, 0f);
                // ---- original
                if (hasO) {
                    java.util.Arrays.fill(o, 0, 2 * frames, 0f);
                    int adj;
                    synchronized (lock) {
                        adj = d.origAdj;
                        d.origAdj = 0;
                    }
                    int carry = readAligned(d.original, o, frames, adj, cIdx, cacheOrig);
                    if (carry != 0) synchronized (lock) {
                        d.origAdj += carry;
                    }
                }
                // ---- stems
                if (hasS) {
                    java.util.Arrays.fill(s, 0, 2 * frames, 0f);
                    int[] adj;
                    synchronized (lock) {
                        adj = d.stemAdj.clone();
                        java.util.Arrays.fill(d.stemAdj, 0);
                    }
                    float[][] cs = cacheStems;
                    for (int k = 0; k < d.stems.length; k++) {
                        java.util.Arrays.fill(t, 0, 2 * frames, 0f);
                        int carry = readAligned(d.stems[k], t, frames, k < adj.length ? adj[k] : 0, cIdx, cs != null ? cs[k] : null);
                        if (carry != 0) synchronized (lock) {
                            if (k < d.stemAdj.length) d.stemAdj[k] += carry;
                        }
                        float a = gFrom[k], b = gTo[k];
                        if (a == 0f && b == 0f) continue;
                        for (int i = 0; i < frames; i++) {
                            float g = a + (b - a) * i / frames;
                            s[2 * i] += g * t[2 * i];
                            s[2 * i + 1] += g * t[2 * i + 1];
                        }
                    }
                }
                // ---- original <-> stems crossfade, master volume
                float nFrom = normGainCur, nTo;
                synchronized (lock) {
                    nTo = normGain;
                    normGainCur = nTo;
                }
                float w = origW;
                float wTarget = !hasS ? 1f : (!hasO ? 0f : (wantOrig ? 1f : 0f));
                for (int i = 0; i < frames; i++) {
                    if (w < wTarget) w = Math.min(wTarget, w + 1f / XFADE);
                    else if (w > wTarget) w = Math.max(wTarget, w - 1f / XFADE);
                    float m = (mFrom + (mTo - mFrom) * i / frames) * (nFrom + (nTo - nFrom) * i / frames);
                    out[2 * i] = m * (w * o[2 * i] + (1 - w) * s[2 * i]);
                    out[2 * i + 1] = m * (w * o[2 * i + 1] + (1 - w) * s[2 * i + 1]);
                }
                int outN = stretchBlock(out, frames, blockPos);
                float[] buf = stretching ? stretchOut : out;
                limiter.process(buf, outN);
                AudioTrack tr = track;
                int wr = outN > 0 ? tr.write(buf, 0, 2 * outN, AudioTrack.WRITE_BLOCKING) : 0;
                if (wr < 0) Log.w(TAG, "AudioTrack.write " + wr);

                boolean ended;
                synchronized (lock) {
                    if (deck != d || pos != blockPos) continue; // reloaded / sought meanwhile: discard bookkeeping
                    origW = w;
                    written += outN;
                    pos += frames;
                    if (cacheIdx >= 0) {
                        cacheIdx += frames;
                        if (cacheIdx >= cacheLen) cacheIdx = -1;
                    }
                    // loop: back to A, playing the pre-decoded start while the decoders reseek
                    if (loopB > loopA && loopA >= 0 && pos >= loopB) {
                        boolean cached = cacheLen > 0 && (cacheOrig != null || cacheStems != null);
                        long resume = cached ? loopA + cacheLen : loopA;
                        if (d.original != null) d.original.seek(resume);
                        for (FrameSource x : d.stems) x.seek(Math.max(0, resume + d.offset));
                        cacheIdx = cached ? 0 : -1;
                        pos = loopA;
                        stretchDirty = true;
                        markLocked(loopA);
                    }
                    boolean oEnd = !hasO || d.original.ended();
                    boolean sEnd = true;
                    for (FrameSource x : d.stems) sEnd &= x.ended();
                    ended = cacheIdx < 0 && (hasO ? oEnd : sEnd) && !(loopB > loopA && loopA >= 0);
                    if (ended) playing = false;
                }
                if (ended) {
                    JSONObject e = new JSONObject();
                    e.put("type", "ended");
                    e.put("songId", d.spec.songId);
                    emit(e);
                    boolean advance, again;
                    synchronized (lock) {
                        boolean sleepNow = sleepAtEnd;
                        if (sleepNow) sleepAtEnd = false;
                        again = !sleepNow && repeatOne;
                        advance = !sleepNow && !again && autoAdvance && !upcoming.isEmpty();
                        // let the last ~120 ms in the buffer play out, then release the output
                        if (!advance && !again && track != null) {
                            final AudioTrack endTrack = track;
                            helper.execute(() -> {
                                try {
                                    Thread.sleep(250);
                                } catch (InterruptedException ignored) {
                                }
                                synchronized (lock) {
                                    if (!playing) endTrack.pause();
                                }
                            });
                        }
                    }
                    if (again) {
                        // "ripeti brano": from the top, still playing
                        seek(0);
                        synchronized (lock) {
                            playing = true;
                            if (track != null) track.play();
                            lock.notifyAll();
                        }
                        emitState();
                    } else if (advance) next();
                    else emitState();
                }
                if (System.currentTimeMillis() - lastTick > 150) {
                    lastTick = System.currentTimeMillis();
                    emitTick();
                }
            } catch (InterruptedException ie) {
                return;
            } catch (Exception ex) {
                Log.e(TAG, "render", ex);
            }
        }
    }

    /** Short "tock" per beat, higher on the first one. */
    private void renderClicks(float[] out, int frames) {
        java.util.Arrays.fill(out, 0, 2 * frames, 0f);
        int len = RATE / 40; // 25 ms
        for (int i = 0; i < frames; i++) {
            int inBeat = clickPhase % clickBeatFrames;
            int beat = clickPhase / clickBeatFrames;
            if (inBeat < len) {
                double f = beat == 0 ? 1500 : 1000;
                float v = (float) (0.6 * Math.sin(2 * Math.PI * f * inBeat / RATE) * Math.exp(-inBeat / (RATE * 0.006)));
                out[2 * i] = v;
                out[2 * i + 1] = v;
            }
            clickPhase++;
        }
    }

    /**
     * Reads one block from a source, honouring a pending realignment
     * (adj > 0 drop frames, adj < 0 insert silence) and the loop cache.
     * Waits briefly for the decoder if it is behind; whatever could not be
     * applied or read in time is returned, to be caught up in the next block,
     * so every source stays on the same frame.
     */
    private int readAligned(FrameSource src, float[] dst, int frames, int adj, int cIdx, float[] cache) throws InterruptedException {
        int filled = 0;
        if (cIdx >= 0 && cache != null) {
            int n = Math.min(frames, cacheLen - cIdx);
            if (n > 0) {
                System.arraycopy(cache, 2 * cIdx, dst, 0, 2 * n);
                filled = n;
            }
            if (filled == frames) return adj;
        }
        int carry = 0;
        if (adj < 0) {
            int insert = Math.min(frames - filled, -adj); // silence (dst is zeroed)
            filled += insert;
            carry = adj + insert;
            if (filled == frames) return carry;
        } else if (adj > 0) {
            float[] junk = new float[2 * Math.min(adj, 8192)];
            int left = adj;
            long end = System.currentTimeMillis() + 120;
            while (left > 0 && System.currentTimeMillis() < end) {
                int n = src.read(junk, 0, Math.min(left, junk.length / 2));
                left -= n;
                if (n == 0) {
                    if (src.ended()) {
                        left = 0;
                        break;
                    }
                    Thread.sleep(2);
                }
            }
            carry = left;
        }
        long deadline = System.currentTimeMillis() + 80;
        while (filled < frames) {
            int n = src.read(dst, filled, frames - filled);
            filled += n;
            if (filled >= frames || src.ended()) break;
            if (n == 0) {
                if (System.currentTimeMillis() > deadline) {
                    carry += frames - filled; // fell behind: skip those frames later
                    break;
                }
                Thread.sleep(2);
            }
        }
        return carry;
    }

    // ------------------------------------------------------------ events

    private JSONObject stateLocked() {
        JSONObject e = new JSONObject();
        try {
            e.put("type", "state");
            e.put("songId", deck != null ? deck.spec.songId : JSONObject.NULL);
            e.put("title", deck != null ? deck.spec.title : "");
            e.put("playing", playing);
            e.put("loading", loading);
            e.put("pos", reportedPosLocked() / (double) RATE);
            e.put("dur", deck != null && deck.durationFrames > 0 ? deck.durationFrames / (double) RATE : 0);
            e.put("source", deck == null ? "none" : (origW >= 0.5f && deck.original != null ? "original" : "stems"));
            e.put("willUse", deck == null ? "none" : (useOriginal ? "original" : "stems"));
            e.put("loop", loopB > loopA && loopA >= 0);
            e.put("countIn", clickRemaining > 0);
            e.put("sleepAt", sleepAt);
            e.put("sleepAtEnd", sleepAtEnd);
            e.put("t", System.currentTimeMillis());
            if (error != null) e.put("error", error);
        } catch (Exception ignored) {
        }
        return e;
    }

    private void emitState() {
        JSONObject e;
        synchronized (lock) {
            e = stateLocked();
        }
        emit(e);
    }

    private void emitStateLater() {
        helper.execute(this::emitState);
    }

    private void emitTick() {
        JSONObject e;
        synchronized (lock) {
            e = stateLocked();
        }
        try {
            e.put("type", "tick");
        } catch (Exception ignored) {
        }
        emit(e);
    }

    private void emitTickLater() {
        helper.execute(this::emitTick);
    }
}
