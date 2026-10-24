package app.stemkitmobile.core;

import java.io.File;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Lyrics without times (only the words) placed on the song: when each line is sung.
 *
 * 1. the vocal track (or the song) says where someone sings: its loudness every 20 ms,
 *    and the "onsets" where the voice comes back after a pause;
 * 2. Whisper (Whisper.java) hears the words and their times; they are matched to the
 *    words of the lyrics (alignment of the two word lists, typos allowed);
 * 3. lines with matched words become anchors (in order, on the nearest onset); the
 *    lines in between go on the onsets between the anchors, by their syllables.
 *
 * Checked in model-export/lyrics (eval_ref.py, v2.py): on songs with known times,
 * about 3 lines in 4 start within 2 s of the truth (8 in 10 once the version's offset is removed).
 */
public final class LyricsAligner {
    public static final double HOP = 0.02;

    private LyricsAligner() {}

    private static Whisper whisper;
    private static File whisperDir;

    /**
     * The start (seconds) of each line of the lyrics in this audio (16 kHz mono: the vocal
     * track if the song is split, else the song).
     * @param models where the Whisper files are (see ModelStore)
     */
    /** the Whisper of the app, loaded once (also for podcast transcripts) */
    public static synchronized Whisper whisper(File models) throws Exception {
        if (whisper == null || !models.equals(whisperDir)) {
            if (whisper != null) whisper.close();
            whisper = new Whisper(models, 4);
            whisperDir = models;
        }
        return whisper;
    }

    public static synchronized double[] align(float[] audio, List<String> lines, File models, Whisper.Progress progress) throws Exception {
        float[] db = envelope(audio);
        boolean[] act = active(db);
        if (whisper == null || !models.equals(whisperDir)) {
            if (whisper != null) whisper.close();
            whisper = new Whisper(models, 4);
            whisperDir = models;
        }
        List<Whisper.Word> heard = whisper.transcribe(audio, language(lines), act, progress);
        return place(lines, heard, act, audio.length / (double) Whisper.SR);
    }

    // ------------------------------------------------------------ the voice

    /** loudness in dB of each 20 ms frame (16 kHz mono) */
    public static float[] envelope(float[] audio) {
        int n = (int) (Whisper.SR * HOP), frames = audio.length / n;
        float[] db = new float[frames];
        for (int f = 0; f < frames; f++) {
            double s = 0;
            for (int i = f * n; i < f * n + n; i++) s += audio[i] * audio[i];
            db[f] = (float) (20 * Math.log10(Math.sqrt(s / n + 1e-12) + 1e-9));
        }
        return db;
    }

    /** frames where someone sings: within 22 dB of the loud parts (smoothed over 60 ms) */
    public static boolean[] active(float[] db) {
        int k = 3, n = db.length;
        float[] sm = new float[n];
        for (int i = 0; i < n; i++) {
            double s = 0;
            int c = 0;
            for (int j = i - k / 2; j <= i + k / 2; j++) {
                if (j < 0 || j >= n) continue;
                s += db[j];
                c++;
            }
            sm[i] = (float) (s / c);
        }
        float[] sorted = sm.clone();
        Arrays.sort(sorted);
        float loud = sorted.length == 0 ? 0 : sorted[(int) (0.95 * (sorted.length - 1))];
        boolean[] act = new boolean[n];
        for (int i = 0; i < n; i++) act[i] = sm[i] > loud - 22;
        return act;
    }

    /** where sung phrases start (seconds): after at least 0.3 s of pause, at least 0.12 s long */
    public static double[] onsets(boolean[] act) {
        List<int[]> runs = new ArrayList<>();
        for (int i = 0; i < act.length; ) {
            if (!act[i]) {
                i++;
                continue;
            }
            int j = i;
            while (j < act.length && act[j]) j++;
            if (!runs.isEmpty() && (i - runs.get(runs.size() - 1)[1]) * HOP < 0.30) runs.get(runs.size() - 1)[1] = j;
            else runs.add(new int[] {i, j});
            i = j;
        }
        List<Double> out = new ArrayList<>();
        for (int[] r : runs) if ((r[1] - r[0]) * HOP >= 0.12) out.add(r[0] * HOP);
        double[] a = new double[out.size()];
        for (int i = 0; i < a.length; i++) a[i] = out.get(i);
        return a;
    }

    // ------------------------------------------------------------ words

    /** lower case, no accents, split on anything that is not a letter or digit */
    public static List<String> words(String s) {
        String t = Normalizer.normalize(s.toLowerCase(Locale.ROOT), Normalizer.Form.NFD).replaceAll("\\p{M}+", "");
        List<String> out = new ArrayList<>();
        for (String w : t.split("[^a-z0-9]+")) if (!w.isEmpty()) out.add(w);
        return out;
    }

    static int syllables(String line) {
        int n = 0;
        boolean in = false;
        for (char c : Normalizer.normalize(line.toLowerCase(Locale.ROOT), Normalizer.Form.NFD).toCharArray()) {
            boolean v = "aeiouy".indexOf(c) >= 0;
            if (v && !in) n++;
            in = v;
        }
        return Math.max(1, n);
    }

    static double similarity(String a, String b) {
        if (a.equals(b)) return 1;
        int la = a.length(), lb = b.length();
        int[] d = new int[lb + 1];
        for (int j = 0; j <= lb; j++) d[j] = j;
        for (int i = 1; i <= la; i++) {
            int p = d[0];
            d[0] = i;
            for (int j = 1; j <= lb; j++) {
                int t = d[j];
                d[j] = Math.min(Math.min(d[j] + 1, d[j - 1] + 1), p + (a.charAt(i - 1) == b.charAt(j - 1) ? 0 : 1));
                p = t;
            }
        }
        return 1 - d[lb] / (double) Math.max(la, lb);
    }

    private static final Map<String, String[]> STOP = new HashMap<>();

    static {
        STOP.put("it", new String[] {"che", "non", "il", "di", "e", "la", "per", "un", "una", "mi", "ti", "sono", "con", "come", "del", "della", "ma", "se", "io", "tu", "nel", "questo", "piu", "ancora", "anche"});
        STOP.put("en", new String[] {"the", "and", "you", "i", "to", "me", "my", "it", "in", "of", "is", "that", "your", "on", "all", "be", "we", "for", "love", "don", "know", "with", "this", "what"});
        STOP.put("es", new String[] {"que", "de", "la", "el", "y", "en", "no", "me", "te", "mi", "tu", "por", "con", "una", "los", "las", "lo", "se", "como", "yo", "pero", "amor", "todo"});
        STOP.put("fr", new String[] {"je", "tu", "le", "la", "les", "et", "de", "des", "un", "une", "est", "pas", "que", "qui", "dans", "mon", "moi", "toi", "pour", "sur", "ce", "c", "j", "on"});
        STOP.put("de", new String[] {"ich", "du", "und", "die", "der", "das", "nicht", "ist", "ein", "eine", "mich", "mir", "dich", "zu", "es", "wir", "sie", "mit", "auf", "in", "den"});
        STOP.put("pt", new String[] {"que", "de", "o", "a", "e", "eu", "voce", "nao", "um", "uma", "meu", "minha", "com", "do", "da", "pra", "para", "te", "se", "mais", "por"});
    }

    /** the language of the lyrics, by their most common words (it, en, es, fr, de, pt) */
    public static String language(List<String> lines) {
        Map<String, Integer> score = new HashMap<>();
        for (String line : lines) {
            for (String w : words(line)) {
                for (Map.Entry<String, String[]> e : STOP.entrySet()) {
                    for (String s : e.getValue()) {
                        if (s.equals(w)) {
                            score.merge(e.getKey(), 1, Integer::sum);
                            break;
                        }
                    }
                }
            }
        }
        String best = "it";
        int top = -1;
        for (Map.Entry<String, Integer> e : score.entrySet()) {
            if (e.getValue() > top) {
                top = e.getValue();
                best = e.getKey();
            }
        }
        return best;
    }

    // ------------------------------------------------------------ placing the lines

    /** start of each line in seconds */
    public static double[] place(List<String> lines, List<Whisper.Word> heard, boolean[] act, double duration) {
        double[] on = onsets(act);
        double[] cum = new double[act.length + 1];
        for (int i = 0; i < act.length; i++) cum[i + 1] = cum[i] + (act[i] ? HOP : 0);
        // words heard where nobody sings are made up (Whisper on silence)
        List<Whisper.Word> asr = new ArrayList<>();
        for (Whisper.Word w : heard) {
            int a = Math.max(0, (int) ((w.t - 0.4) / HOP)), b = Math.min(act.length, (int) ((w.t + 0.6) / HOP));
            for (int i = a; i < b; i++) {
                if (act[i]) {
                    asr.add(w);
                    break;
                }
            }
        }
        // the words of the lyrics, with their line
        List<String> lw = new ArrayList<>();
        List<Integer> lline = new ArrayList<>();
        for (int li = 0; li < lines.size(); li++) {
            for (String w : words(lines.get(li))) {
                lw.add(w);
                lline.add(li);
            }
        }
        double[] match = matchWords(lw, asr);
        int N = lines.size();
        double[] anchor = new double[N], conf = new double[N];
        boolean[] has = new boolean[N];
        int k = 0;
        for (int li = 0; li < N; li++) {
            int pos = 0, first = -1, total = 0, got = 0;
            double t = 0;
            while (k < lw.size() && lline.get(k) == li) {
                if (!Double.isNaN(match[k])) {
                    got++;
                    if (first < 0) {
                        first = pos;
                        t = match[k];
                    }
                }
                pos++;
                total++;
                k++;
            }
            if (first < 0) continue;
            double a = t - 0.3 * first;
            double best = a, bestD = Double.MAX_VALUE;
            for (double o : on) {
                if (o >= a - 1.2 && o <= a + 0.4 && Math.abs(o - a) < bestD) {
                    bestD = Math.abs(o - a);
                    best = o;
                }
            }
            anchor[li] = best;
            conf[li] = got / (double) Math.max(1, total);
            has[li] = true;
        }
        // the longest chain of anchors in time order (weighted by how many words matched)
        double[] score = new double[N];
        int[] prev = new int[N];
        int end = -1;
        for (int a = 0; a < N; a++) {
            if (!has[a]) continue;
            score[a] = conf[a];
            prev[a] = -1;
            for (int b = 0; b < a; b++) {
                if (has[b] && anchor[b] < anchor[a] - 0.5 && score[b] + conf[a] > score[a]) {
                    score[a] = score[b] + conf[a];
                    prev[a] = b;
                }
            }
            if (end < 0 || score[a] > score[end]) end = a;
        }
        List<Integer> chain = new ArrayList<>();
        for (int c = end; c >= 0; c = prev[c]) chain.add(0, c);
        double[] times = new double[N];
        Arrays.fill(times, Double.NaN);
        for (int c : chain) times[c] = anchor[c];
        // the other lines: on the onsets between their anchors, shared by syllables in sung time
        int[] syl = new int[N];
        int totalSyl = 0;
        for (int i = 0; i < N; i++) totalSyl += syl[i] = syllables(lines.get(i));
        double rate = cum[cum.length - 1] / Math.max(1, totalSyl);
        List<int[]> bounds = new ArrayList<>();
        bounds.add(new int[] {-1});
        for (int c : chain) bounds.add(new int[] {c});
        bounds.add(new int[] {N});
        for (int b = 0; b + 1 < bounds.size(); b++) {
            int ka = bounds.get(b)[0], kb = bounds.get(b + 1)[0];
            if (kb - ka < 2) continue;
            double start = ka >= 0 ? times[ka] : (on.length > 0 ? on[0] : 0);
            double tb = kb < N ? times[kb] : duration;
            double va = voiced(cum, start), vb = voiced(cum, tb);
            double[] weights = new double[kb - ka];
            weights[0] = ka >= 0 ? syl[ka] : 0;
            for (int i = ka + 1; i < kb; i++) weights[i - ka] = syl[i];
            double tot = 0;
            for (double w : weights) tot += w;
            if (kb == N) vb = Math.min(vb, va + rate * tot * 1.3);
            double acc = 0;
            for (int i = ka + 1; i < kb; i++) {
                acc += weights[i - ka - 1];
                double target = va + (vb - va) * acc / Math.max(1, tot);
                int f = Arrays.binarySearch(cum, target);
                if (f < 0) f = -f - 1;
                double t = f * HOP, best = t, bestD = Double.MAX_VALUE;
                for (double o : on) {
                    if (o > start + 0.3 && o < tb - 0.3 && o >= t - 2.5 && o <= t + 2.5 && Math.abs(o - t) < bestD) {
                        bestD = Math.abs(o - t);
                        best = o;
                    }
                }
                times[i] = best;
                if (i > ka + 1 && times[i] <= times[i - 1]) times[i] = times[i - 1] + 0.5;
            }
        }
        return times;
    }

    private static double voiced(double[] cum, double t) {
        return cum[Math.min(cum.length - 1, Math.max(0, (int) (t / HOP)))];
    }

    /** for each lyric word, the time of the heard word it matches (NaN: none) */
    private static double[] matchWords(List<String> L, List<Whisper.Word> A) {
        int n = L.size(), m = A.size();
        float[][] S = new float[n + 1][m + 1];
        byte[][] B = new byte[n + 1][m + 1];
        for (int i = 1; i <= n; i++) S[i][0] = -0.4f * i;
        for (int j = 1; j <= m; j++) S[0][j] = -0.3f * j;
        for (int i = 1; i <= n; i++) {
            String wi = L.get(i - 1);
            for (int j = 1; j <= m; j++) {
                double sim = similarity(wi, A.get(j - 1).text);
                float diag = S[i - 1][j - 1] + (float) (sim >= 0.6 ? 2 * sim : -0.6);
                float up = S[i - 1][j] - 0.4f, left = S[i][j - 1] - 0.3f;
                if (diag >= up && diag >= left) {
                    S[i][j] = diag;
                    B[i][j] = 0;
                } else if (up >= left) {
                    S[i][j] = up;
                    B[i][j] = 1;
                } else {
                    S[i][j] = left;
                    B[i][j] = 2;
                }
            }
        }
        double[] out = new double[n];
        Arrays.fill(out, Double.NaN);
        int i = n, j = m;
        while (i > 0 && j > 0) {
            if (B[i][j] == 0) {
                if (similarity(L.get(i - 1), A.get(j - 1).text) >= 0.6) out[i - 1] = A.get(j - 1).t;
                i--;
                j--;
            } else if (B[i][j] == 1) {
                i--;
            } else {
                j--;
            }
        }
        return out;
    }
}
