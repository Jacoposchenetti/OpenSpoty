package app.stemkitmobile.core;

import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.LongBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Whisper tiny (OpenAI, MIT) on ONNX Runtime: what is sung, and when.
 * The models come from model-export/lyrics/export_whisper.py; this is the
 * same decoding as model-export/lyrics/whisper_ref.py (30 s windows, greedy,
 * Whisper's timestamp rules, words timed inside each segment by their length).
 */
public final class Whisper implements AutoCloseable {
    public static final int SR = 16000;
    private static final int NFFT = 400, HOP = 160, FRAMES = 3000, BINS = 201, MELS = 80, CHUNK = 30;
    private static final int LAYERS2 = 8, D = 384, MAX_STEPS = 224;

    public static final String[] FILES = {"whisper_encoder.onnx", "whisper_decoder.onnx", "whisper_mel.bin", "whisper_vocab.json"};

    public static final class Word {
        public final String text;
        public final double t;

        Word(String text, double t) {
            this.text = text;
            this.t = t;
        }
    }

    public interface Progress {
        void at(float fraction);
    }

    /** a stretch of speech with its text (podcast transcripts) */
    public static final class Segment {
        public final double a, b;
        public final String text;

        Segment(double a, double b, String text) {
            this.a = a;
            this.b = b;
            this.text = text;
        }
    }

    private interface Sink {
        void segment(String text, double a, double b);
    }

    private final OrtEnvironment env;
    private final OrtSession enc, dec;
    private final float[] mel; // [80][201]
    private final String[] tokens;
    private final int sot, eot, transcribe, notimestamps, ts0;
    private final int[] suppress, beginSuppress;
    private final Map<String, Integer> languages = new HashMap<>();

    public Whisper(File dir, int threads) throws Exception {
        env = OrtEnvironment.getEnvironment();
        OrtSession.SessionOptions o = new OrtSession.SessionOptions();
        o.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
        if (threads > 0) o.setIntraOpNumThreads(threads);
        enc = env.createSession(new File(dir, FILES[0]).getAbsolutePath(), o);
        dec = env.createSession(new File(dir, FILES[1]).getAbsolutePath(), o);
        ByteBuffer mb = ByteBuffer.wrap(Files.readAllBytes(new File(dir, FILES[2]).toPath())).order(ByteOrder.LITTLE_ENDIAN);
        mel = new float[MELS * BINS];
        mb.asFloatBuffer().get(mel);
        JSONObject v = new JSONObject(new String(Files.readAllBytes(new File(dir, FILES[3]).toPath()), StandardCharsets.UTF_8));
        JSONArray t = v.getJSONArray("tokens");
        tokens = new String[t.length()];
        for (int i = 0; i < tokens.length; i++) tokens[i] = t.getString(i);
        sot = v.getInt("sot");
        eot = v.getInt("eot");
        transcribe = v.getInt("transcribe");
        notimestamps = v.getInt("notimestamps");
        ts0 = v.getInt("ts0");
        suppress = ints(v.getJSONArray("suppress"));
        beginSuppress = ints(v.getJSONArray("beginSuppress"));
        JSONObject l = v.getJSONObject("languages");
        for (java.util.Iterator<String> it = l.keys(); it.hasNext(); ) {
            String k = it.next();
            languages.put(k, l.getInt(k));
        }
    }

    private static int[] ints(JSONArray a) throws Exception {
        int[] out = new int[a.length()];
        for (int i = 0; i < out.length; i++) out[i] = a.getInt(i);
        return out;
    }

    public boolean knows(String lang) {
        return languages.containsKey(lang);
    }

    /**
     * Words with their start, for a whole song (16 kHz mono).
     * @param voiced per 20 ms frame: is someone singing (windows without singing are skipped); may be null
     */
    public List<Word> transcribe(float[] audio, String lang, boolean[] voiced, Progress progress) throws OrtException {
        List<Word> words = new ArrayList<>();
        double total = audio.length / (double) SR, pos = 0;
        int language = languages.getOrDefault(lang, languages.getOrDefault("it", 50274));
        while (pos < total - 0.5) {
            if (progress != null) progress.at((float) (pos / total));
            if (voiced != null && share(voiced, pos, pos + CHUNK) <= 0.03) {
                pos += CHUNK;
                continue;
            }
            int from = (int) (pos * SR), n = Math.min(SR * CHUNK, audio.length - from);
            float[] seg = new float[n];
            System.arraycopy(audio, from, seg, 0, n);
            double end = window(seg, language, pos, (text, a, b) -> addWords(text, a, b, words));
            pos += end > 1.0 ? end : CHUNK;
        }
        if (progress != null) progress.at(1f);
        return words;
    }

    /**
     * The speech of up to 30 s (16 kHz mono) starting at {@code offset} seconds of the episode:
     * its segments, and where the next window should start (after the last complete segment).
     */
    public double segments(float[] audio, String lang, double offset, List<Segment> out) throws OrtException {
        int language = languages.getOrDefault(lang, languages.getOrDefault("it", 50274));
        float[] seg = audio.length > SR * CHUNK ? java.util.Arrays.copyOf(audio, SR * CHUNK) : audio;
        double end = window(seg, language, offset, (text, a, b) -> {
            String t = text.trim();
            if (!t.isEmpty()) out.add(new Segment(a, b, t));
        });
        double heard = seg.length / (double) SR;
        return offset + (end > 1.0 && end < heard - 0.5 ? end : heard);
    }

    /** the language spoken in up to 30 s of audio (Whisper's own guess: "it", "en", ...) */
    public String detect(float[] audio) throws OrtException {
        float[] seg = audio.length > SR * CHUNK ? java.util.Arrays.copyOf(audio, SR * CHUNK) : audio;
        float[] cross;
        try (OnnxTensor m = OnnxTensor.createTensor(env, FloatBuffer.wrap(logMel(seg)), new long[] {1, MELS, FRAMES});
             OrtSession.Result r = enc.run(java.util.Collections.singletonMap("mel", m))) {
            FloatBuffer b = ((OnnxTensor) r.get(0)).getFloatBuffer();
            cross = new float[b.remaining()];
            b.get(cross);
        }
        Map<String, OnnxTensor> in = new HashMap<>();
        try (OnnxTensor tk = OnnxTensor.createTensor(env, LongBuffer.wrap(new long[] {sot}), new long[] {1, 1});
             OnnxTensor ps = OnnxTensor.createTensor(env, FloatBuffer.wrap(new float[0]), new long[] {LAYERS2, 0, D});
             OnnxTensor cr = OnnxTensor.createTensor(env, FloatBuffer.wrap(cross), new long[] {LAYERS2, cross.length / LAYERS2 / D, D})) {
            in.put("tokens", tk);
            in.put("past", ps);
            in.put("cross", cr);
            try (OrtSession.Result r = dec.run(in)) {
                FloatBuffer lb = ((OnnxTensor) r.get(0)).getFloatBuffer();
                float[] lg = new float[lb.remaining()];
                lb.get(lg);
                String best = "it";
                float top = Float.NEGATIVE_INFINITY;
                for (Map.Entry<String, Integer> e : languages.entrySet()) {
                    if (e.getValue() < lg.length && lg[e.getValue()] > top) {
                        top = lg[e.getValue()];
                        best = e.getKey();
                    }
                }
                return best;
            }
        }
    }

    private static double share(boolean[] voiced, double a, double b) {
        int i0 = (int) (a / 0.02), i1 = Math.min(voiced.length, (int) (b / 0.02));
        if (i1 <= i0) return 0;
        int on = 0;
        for (int i = i0; i < i1; i++) if (voiced[i]) on++;
        return on / (double) (i1 - i0);
    }

    /** one 30 s window: its segments' words go into out; returns where the last complete segment ended */
    private double window(float[] seg, int language, double offset, Sink out) throws OrtException {
        float[] cross;
        try (OnnxTensor m = OnnxTensor.createTensor(env, FloatBuffer.wrap(logMel(seg)), new long[] {1, MELS, FRAMES});
             OrtSession.Result r = enc.run(java.util.Collections.singletonMap("mel", m))) {
            FloatBuffer b = ((OnnxTensor) r.get(0)).getFloatBuffer();
            cross = new float[b.remaining()];
            b.get(cross);
        }
        int[] prompt = {sot, language, transcribe};
        List<Integer> gen = new ArrayList<>();
        float[] past = new float[0];
        int pastLen = 0;
        long[] feed = {sot, language, transcribe};
        try (OnnxTensor crossT = OnnxTensor.createTensor(env, FloatBuffer.wrap(cross), new long[] {LAYERS2, cross.length / LAYERS2 / D, D})) {
            for (int step = 0; step < MAX_STEPS; step++) {
                float[] logits;
                Map<String, OnnxTensor> in = new HashMap<>();
                try (OnnxTensor tk = OnnxTensor.createTensor(env, LongBuffer.wrap(feed), new long[] {1, feed.length});
                     OnnxTensor ps = OnnxTensor.createTensor(env, FloatBuffer.wrap(past), new long[] {LAYERS2, pastLen, D})) {
                    in.put("tokens", tk);
                    in.put("past", ps);
                    in.put("cross", crossT);
                    try (OrtSession.Result r = dec.run(in)) {
                        FloatBuffer lb = ((OnnxTensor) r.get(0)).getFloatBuffer();
                        logits = new float[lb.remaining()];
                        lb.get(logits);
                        FloatBuffer pb = ((OnnxTensor) r.get(1)).getFloatBuffer();
                        past = new float[pb.remaining()];
                        pb.get(past);
                        pastLen += feed.length;
                    }
                }
                int t = next(logits, gen);
                if (t == eot) break;
                gen.add(t);
                feed = new long[] {t};
            }
        }
        // segments: <|start|> text <|end|>
        double end = 0;
        Double start = null;
        List<Integer> text = new ArrayList<>();
        for (int t : gen) {
            if (t >= ts0) {
                double sec = (t - ts0) * 0.02;
                if (start == null) {
                    start = sec;
                } else {
                    if (!text.isEmpty()) {
                        out.segment(decode(text), offset + start, offset + sec);
                        end = sec;
                    }
                    start = null;
                    text.clear();
                }
            } else {
                text.add(t);
            }
        }
        return end;
    }

    /** greedy choice under Whisper's rules for timestamps */
    private int next(float[] lg, List<Integer> gen) {
        float NEG = Float.NEGATIVE_INFINITY;
        int V = lg.length;
        lg[notimestamps] = NEG;
        for (int s : suppress) if (s < V) lg[s] = NEG;
        boolean first = gen.isEmpty() || (gen.size() == 1 && gen.get(0) >= ts0);
        if (first) for (int s : beginSuppress) if (s < V) lg[s] = NEG;
        for (int i = sot; i < ts0; i++) lg[i] = NEG; // other special tokens
        int n = gen.size();
        boolean lastTs = n >= 1 && gen.get(n - 1) >= ts0;
        boolean prevTs = n < 2 || gen.get(n - 2) >= ts0;
        if (lastTs) {
            if (prevTs) for (int i = ts0; i < V; i++) lg[i] = NEG; // after a pair: text
            else for (int i = 0; i < eot; i++) lg[i] = NEG; // closing a segment: a timestamp or the end
        }
        int lastStamp = -1;
        for (int i = n - 1; i >= 0; i--) if (gen.get(i) >= ts0) { lastStamp = gen.get(i); break; }
        if (lastStamp >= 0) {
            int lo = lastStamp + (lastTs && !prevTs ? 0 : 1);
            for (int i = ts0; i < Math.min(lo, V); i++) lg[i] = NEG;
        }
        if (n == 0) {
            for (int i = 0; i < ts0; i++) lg[i] = NEG; // starts with a timestamp
            for (int i = ts0 + 51; i < V; i++) lg[i] = NEG; // within the first second
        }
        // a timestamp when all of them together are likelier than any text token
        float max = NEG;
        for (float x : lg) if (x > max) max = x;
        double tsSum = 0, textMax = 0;
        for (int i = 0; i < V; i++) {
            if (lg[i] == NEG) continue;
            double p = Math.exp(lg[i] - max);
            if (i >= ts0) tsSum += p;
            else if (p > textMax) textMax = p;
        }
        if (tsSum > textMax) for (int i = 0; i < ts0; i++) lg[i] = NEG;
        int best = 0;
        for (int i = 1; i < V; i++) if (lg[i] > lg[best]) best = i;
        return best;
    }

    private String decode(List<Integer> ids) {
        StringBuilder b = new StringBuilder();
        for (int i : ids) if (i < tokens.length) b.append(tokens[i]);
        return new String(b.toString().getBytes(StandardCharsets.ISO_8859_1), StandardCharsets.UTF_8);
    }

    private static void addWords(String text, double a, double b, List<Word> out) {
        List<String> ws = LyricsAligner.words(text);
        int n = 0;
        for (String w : ws) n += w.length();
        int acc = 0;
        for (String w : ws) {
            out.add(new Word(w, a + (b - a) * acc / Math.max(1, n)));
            acc += w.length();
        }
    }

    /** 22.05 kHz mono (Engine.decodeMono22k) to Whisper's 16 kHz: windowed-sinc low-pass at 7.6 kHz */
    public static float[] to16k(float[] x) {
        double ratio = 22050.0 / SR, fc = 7600.0 / 22050.0;
        int half = 12;
        float[] out = new float[(int) (x.length / ratio)];
        for (int o = 0; o < out.length; o++) {
            double t = o * ratio;
            int c = (int) Math.floor(t);
            double acc = 0, norm = 0;
            for (int k = c - half + 1; k <= c + half; k++) {
                double d = t - k;
                double h = (d == 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * d) / (Math.PI * d))
                    * (0.5 + 0.5 * Math.cos(Math.PI * d / half));
                norm += h;
                if (k >= 0 && k < x.length) acc += h * x[k];
            }
            out[o] = (float) (acc / norm);
        }
        return out;
    }

    // ------------------------------------------------------------ log-mel

    private static final int BL = 1024; // Bluestein: the 400-point DFT through 1024-point FFTs
    private static Fft fft;
    private static double[] chirpRe, chirpIm, kernRe, kernIm, hann;

    private static synchronized void tables() {
        if (fft != null) return;
        fft = new Fft(BL);
        chirpRe = new double[NFFT];
        chirpIm = new double[NFFT];
        for (int n = 0; n < NFFT; n++) {
            double a = Math.PI * ((long) n * n % (2L * NFFT)) / NFFT;
            chirpRe[n] = Math.cos(a);
            chirpIm[n] = -Math.sin(a);
        }
        kernRe = new double[BL];
        kernIm = new double[BL];
        for (int n = 0; n < NFFT; n++) {
            kernRe[n] = chirpRe[n];
            kernIm[n] = -chirpIm[n];
            if (n > 0) {
                kernRe[BL - n] = chirpRe[n];
                kernIm[BL - n] = -chirpIm[n];
            }
        }
        fft.transform(kernRe, kernIm, false);
        hann = new double[NFFT];
        for (int i = 0; i < NFFT; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NFFT); // periodic
    }

    /** Whisper's log-mel spectrogram of up to 30 s: [80][3000], row major */
    float[] logMel(float[] x) {
        tables();
        int len = SR * CHUNK, pad = NFFT / 2;
        float[] y = new float[len + 2 * pad];
        for (int i = 0; i < len; i++) y[pad + i] = i < x.length ? x[i] : 0f;
        for (int i = 0; i < pad; i++) { // reflect
            y[pad - 1 - i] = y[pad + 1 + i];
            y[pad + len + i] = y[pad + len - 2 - i];
        }
        float[] out = new float[MELS * FRAMES];
        double[] re = new double[BL], im = new double[BL], power = new double[BINS];
        double top = -1e30;
        for (int f = 0; f < FRAMES; f++) {
            java.util.Arrays.fill(re, 0);
            java.util.Arrays.fill(im, 0);
            int s = f * HOP;
            for (int n = 0; n < NFFT; n++) {
                double v = y[s + n] * hann[n];
                re[n] = v * chirpRe[n];
                im[n] = v * chirpIm[n];
            }
            fft.transform(re, im, false);
            for (int k = 0; k < BL; k++) {
                double r = re[k] * kernRe[k] - im[k] * kernIm[k];
                double i = re[k] * kernIm[k] + im[k] * kernRe[k];
                re[k] = r;
                im[k] = i;
            }
            fft.transform(re, im, true);
            for (int k = 0; k < BINS; k++) {
                double r = (re[k] * chirpRe[k] - im[k] * chirpIm[k]) / BL;
                double i = (re[k] * chirpIm[k] + im[k] * chirpRe[k]) / BL;
                power[k] = r * r + i * i;
            }
            for (int m = 0; m < MELS; m++) {
                double acc = 0;
                int row = m * BINS;
                for (int k = 0; k < BINS; k++) acc += mel[row + k] * power[k];
                double lv = Math.log10(Math.max(acc, 1e-10));
                out[m * FRAMES + f] = (float) lv;
                if (lv > top) top = lv;
            }
        }
        float floor = (float) (top - 8.0);
        for (int i = 0; i < out.length; i++) out[i] = (Math.max(out[i], floor) + 4f) / 4f;
        return out;
    }

    @Override
    public void close() throws OrtException {
        enc.close();
        dec.close();
    }
}
