package app.stemkitmobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import app.stemkitmobile.core.OrtModel;
import app.stemkitmobile.core.Separator;

/**
 * Splits one song on the phone, as a foreground service so it keeps going
 * with the screen off. Writes songs/<id>/<stem>.m4a plus meta.json; the
 * web app adopts the song from meta.json (even after a restart).
 */
public class SeparationService extends Service {
    private static final String TAG = "StemKitSplit";
    private static final String CHANNEL = "separation";
    private static final int NOTIF_ID = 42;
    static final String MODEL_ASSET = "models/htdemucs_6s.onnx";
    // order of the model's outputs (demucs htdemucs_6s.sources)
    static final String[] MODEL_STEMS = {"drums", "bass", "other", "vocals", "guitar", "piano"};

    interface Listener {
        void onEvent(JSONObject event);
    }

    static volatile Listener listener;
    static volatile JSONObject lastEvent;
    private static volatile boolean cancelRequested;
    private static volatile boolean running;

    /** One song to split: a local file, or a YouTube video downloaded first. */
    private static final class Job {
        String path, youtubeId, songId, title;
        String[] stems;
        boolean existing; // split the original already saved in songs/<id>/
        boolean flac = true;
    }

    // songs waiting while another one is being split
    private static final java.util.ArrayDeque<Job> queue = new java.util.ArrayDeque<>();
    private static volatile String currentSongId;

    static boolean isRunning() {
        return running;
    }

    /** true if the song is being split or is waiting in the queue */
    static boolean isQueued(String songId) {
        synchronized (queue) {
            if (songId.equals(currentSongId)) return true;
            for (Job j : queue) if (j.songId.equals(songId)) return true;
        }
        return false;
    }

    static void requestCancel() {
        cancelRequested = true;
    }

    static void cancelAll() {
        synchronized (queue) {
            queue.clear();
        }
        cancelRequested = true;
    }

    private static JSONArray queueTitles() {
        JSONArray a = new JSONArray();
        synchronized (queue) {
            for (Job j : queue) a.put(j.title);
        }
        return a;
    }

    private NotificationManager nm;
    private PowerManager.WakeLock wakeLock;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;
        Job job = new Job();
        job.path = intent.getStringExtra("path");
        job.youtubeId = intent.getStringExtra("youtubeId");
        job.songId = intent.getStringExtra("songId");
        job.title = intent.getStringExtra("title");
        job.stems = intent.getStringArrayExtra("stems");
        job.existing = intent.getBooleanExtra("existing", false);
        job.flac = !"aac".equals(intent.getStringExtra("quality"));
        synchronized (queue) {
            queue.add(job);
        }
        if (running) {
            // already working: just tell the app the queue grew
            JSONObject e = lastEvent;
            if (e != null) {
                try {
                    JSONObject copy = new JSONObject(e.toString());
                    copy.put("queue", queueTitles());
                    lastEvent = copy;
                    Listener l = listener;
                    if (l != null) l.onEvent(copy);
                } catch (Exception ignored) {
                }
            }
            return START_NOT_STICKY;
        }
        String title = job.title;
        nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Separazione tracce", NotificationManager.IMPORTANCE_LOW));
        }
        Notification n = notification(title, "Avvio…", 0);
        if (Build.VERSION.SDK_INT >= 35) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING);
        } else if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIF_ID, n);
        }
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "stemkit:separation");
        wakeLock.acquire(3 * 60 * 60 * 1000L);
        running = true;
        new Thread(this::drainQueue, "stemkit-separation").start();
        return START_NOT_STICKY;
    }

    private void drainQueue() {
        try {
            while (true) {
                Job job;
                synchronized (queue) {
                    job = queue.poll();
                    currentSongId = job != null ? job.songId : null;
                }
                if (job == null) break;
                cancelRequested = false;
                lastNotify = 0;
                work(job);
            }
        } finally {
            running = false;
            currentSongId = null;
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
        }
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        // Android 15 limit for media-processing services: give up cleanly
        requestCancel();
    }

    private Notification notification(String title, String text, int pct) {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(title)
            .setContentText(text)
            .setProgress(100, pct, false)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(pi)
            .build();
    }

    private long lastNotify = 0;

    private synchronized void emit(String songId, String title, String state, float pct, String message, JSONObject extra) {
        try {
            JSONObject e = new JSONObject();
            e.put("songId", songId);
            e.put("title", title);
            e.put("state", state);
            e.put("pct", Math.round(pct * 10) / 10.0);
            e.put("message", message);
            e.put("queue", queueTitles());
            if (extra != null) {
                for (java.util.Iterator<String> it = extra.keys(); it.hasNext(); ) {
                    String k = it.next();
                    e.put(k, extra.get(k));
                }
            }
            lastEvent = e;
            Listener l = listener;
            if (l != null) l.onEvent(e);
            long now = System.currentTimeMillis();
            if ("running".equals(state) && now - lastNotify > 1000) {
                lastNotify = now;
                nm.notify(NOTIF_ID, notification(title, message + " " + Math.round(pct) + "%", Math.round(pct)));
            }
        } catch (Exception ex) {
            Log.w(TAG, "emit", ex);
        }
    }

    private void work(Job job) {
        final String songId = job.songId, title = job.title;
        String[] wanted = job.stems;
        String path = job.path;
        File dir = new File(getFilesDir(), "songs/" + songId);
        List<String> keep = new ArrayList<>(Arrays.asList(wanted != null && wanted.length > 0 ? wanted : MODEL_STEMS));
        long started = System.currentTimeMillis();
        final boolean dirExisted = dir.isDirectory();
        File original;
        try {
            if (!dir.mkdirs() && !dir.isDirectory()) throw new IllegalStateException("cartella non creata");
            // the unseparated song stays next to its stems, untouched, for listening
            if (job.existing) {
                original = findOriginal(dir);
                if (original == null) throw new IllegalStateException("Il file originale non c'è più: riscarica la canzone");
            } else if (job.youtubeId != null) {
                emit(songId, title, "running", 0, "Download da YouTube", null);
                original = YouTubeSource.download(job.youtubeId, dir, "original", f -> {
                    emit(songId, title, "running", 3 * f, "Download da YouTube", null);
                    return !cancelRequested;
                }).file;
            } else {
                original = adoptPicked(new File(path), dir);
            }
            path = original.getAbsolutePath();
            check();
            final float base = job.youtubeId != null ? 3 : 0;
            emit(songId, title, "running", base, "Lettura dell'audio", null);
            AudioDecoder.Result audio = AudioDecoder.decode(path, f -> emit(songId, title, "running", base + 2 * f, "Lettura dell'audio", null));
            check();
            emit(songId, title, "running", 3, "Caricamento del modello", null);
            File model = ensureModel();
            int frames = audio.frames;
            short[] pcm = audio.pcm;
            File[] wavs = new File[MODEL_STEMS.length];
            StemFiles.WavWriter[] writers = new StemFiles.WavWriter[MODEL_STEMS.length];
            for (int s = 0; s < MODEL_STEMS.length; s++) {
                if (!keep.contains(MODEL_STEMS[s])) continue;
                wavs[s] = new File(dir, MODEL_STEMS[s] + ".wav");
                writers[s] = new StemFiles.WavWriter(wavs[s]);
            }
            boolean finished;
            try (OrtModel m = new OrtModel(model.getAbsolutePath(), 0)) {
                if (m.sources() != MODEL_STEMS.length) throw new IllegalStateException("modello inatteso");
                Separator.Source src = new Separator.Source() {
                    @Override
                    public int length() {
                        return frames;
                    }

                    @Override
                    public void read(int from, int count, float[][] dst) {
                        float[] l = dst[0], r = dst[1];
                        for (int i = 0; i < count; i++) {
                            int k = from + i;
                            if (k < 0 || k >= frames) {
                                l[i] = 0;
                                r[i] = 0;
                            } else {
                                l[i] = pcm[2 * k] / 32768f;
                                r[i] = pcm[2 * k + 1] / 32768f;
                            }
                        }
                    }
                };
                long t0 = System.currentTimeMillis();
                finished = Separator.separate(src, m, (data, count) -> {
                    for (int s = 0; s < writers.length; s++) {
                        if (writers[s] != null) writers[s].write(data[s][0], data[s][1], count);
                    }
                }, (done, total) -> {
                    if (cancelRequested) return false;
                    String msg = "Separazione";
                    if (done > 0) {
                        long perSeg = (System.currentTimeMillis() - t0) / done;
                        long left = perSeg * (total - done) / 1000;
                        msg = "Separazione · ~" + (left >= 60 ? (left / 60) + " min" : left + " s");
                    }
                    emit(songId, title, "running", 4 + 86f * done / total, msg, null);
                    return true;
                });
            } finally {
                for (StemFiles.WavWriter w : writers) {
                    if (w != null) w.close();
                }
            }
            check();
            if (!finished) throw new InterruptedException();

            // FLAC (lossless, ~13 MB per stem) or AAC 256 kbps (~6 MB) instead of ~35 MB of WAV
            final String ext = job.flac ? "flac" : "m4a";
            JSONObject files = new JSONObject();
            JSONArray produced = new JSONArray();
            float[] stemDone = new float[MODEL_STEMS.length];
            int total = 0;
            for (File w : wavs) if (w != null) total++;
            final int tot = total;
            String[] fileFor = new String[MODEL_STEMS.length];
            java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(3);
            List<java.util.concurrent.Future<?>> jobs = new ArrayList<>();
            for (int s = 0; s < MODEL_STEMS.length; s++) {
                if (wavs[s] == null) continue;
                final int si = s;
                jobs.add(pool.submit(() -> {
                    String name = MODEL_STEMS[si];
                    File enc = new File(dir, name + "." + ext);
                    long wavFrames = (wavs[si].length() - 44) / 4;
                    try {
                        StemFiles.encodeWav(wavs[si], enc, job.flac, f -> {
                            stemDone[si] = f;
                            float sum = 0;
                            for (float d : stemDone) sum += d;
                            emit(songId, title, "running", 90 + 10f * sum / tot, "Compressione tracce", null);
                        });
                        if (job.flac) StemFiles.patchFlacTotalSamples(enc, wavFrames);
                        //noinspection ResultOfMethodCallIgnored
                        wavs[si].delete();
                        fileFor[si] = "songs/" + songId + "/" + name + "." + ext;
                    } catch (Exception err) {
                        Log.w(TAG, ext + " failed, keeping WAV for " + name, err);
                        //noinspection ResultOfMethodCallIgnored
                        enc.delete();
                        fileFor[si] = "songs/" + songId + "/" + name + ".wav";
                    }
                }));
            }
            pool.shutdown();
            for (java.util.concurrent.Future<?> j : jobs) j.get();
            for (int s = 0; s < MODEL_STEMS.length; s++) {
                if (fileFor[s] == null) continue;
                files.put(MODEL_STEMS[s], fileFor[s]);
                produced.put(MODEL_STEMS[s]);
            }
            JSONObject meta = new JSONObject();
            meta.put("songId", songId);
            meta.put("title", title);
            meta.put("duration", Math.round(frames / (double) AudioDecoder.RATE));
            meta.put("stems", produced);
            meta.put("files", files);
            meta.put("original", "songs/" + songId + "/" + original.getName());
            meta.put("finishedAt", System.currentTimeMillis());
            meta.put("took", (System.currentTimeMillis() - started) / 1000);
            writeAtomic(new File(dir, "meta.json"), meta.toString(2));
            JSONObject extra = new JSONObject();
            extra.put("stems", produced);
            extra.put("duration", meta.getLong("duration"));
            emit(songId, title, "done", 100, "Pronta", extra);
            nm.notify(songId.hashCode(), new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle(title)
                .setContentText("Tracce pronte")
                .setAutoCancel(true)
                .build());
        } catch (Throwable t) {
            boolean cancelled = t instanceof InterruptedException || cancelRequested;
            Log.e(TAG, "separation failed", t);
            if (dirExisted) removePartialStems(dir); // keep the song (and its original) as it was
            else deleteTree(dir);
            String msg = cancelled ? "Annullata" : (t instanceof OutOfMemoryError ? "Memoria insufficiente" : String.valueOf(t.getMessage()));
            try {
                JSONObject extra = new JSONObject();
                extra.put("error", msg);
                emit(songId, title, "failed", 0, cancelled ? "Annullata" : "Errore", extra);
            } catch (Exception ignored) {
            }
        } finally {
            // a picked file that never made it into the song folder
            if (job.path != null && job.path.startsWith(getCacheDir().getAbsolutePath())) //noinspection ResultOfMethodCallIgnored
                new File(job.path).delete();
        }
    }

    static File findOriginal(File dir) {
        File[] kids = dir.listFiles();
        if (kids != null) for (File k : kids) if (k.getName().startsWith("original.") && !k.getName().endsWith(".part")) return k;
        return null;
    }

    /** Moves a file picked from the phone into the song folder as original.<ext>. */
    static File adoptPicked(File picked, File dir) throws java.io.IOException {
        String name = picked.getName();
        int dot = name.lastIndexOf('.');
        String ext = dot >= 0 ? name.substring(dot + 1).toLowerCase(java.util.Locale.ROOT) : "audio";
        if (!ext.matches("[a-z0-9]{1,5}")) ext = "audio";
        File dst = new File(dir, "original." + ext);
        if (picked.renameTo(dst)) return dst;
        try (java.io.InputStream in = new java.io.FileInputStream(picked); OutputStream o = new FileOutputStream(dst)) {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
        }
        //noinspection ResultOfMethodCallIgnored
        picked.delete();
        return dst;
    }

    private static void removePartialStems(File dir) {
        File[] kids = dir.listFiles();
        if (kids == null) return;
        for (File k : kids) {
            String n = k.getName();
            if (n.startsWith("original.") || n.equals("meta.json")) continue;
            //noinspection ResultOfMethodCallIgnored
            k.delete();
        }
    }

    private static void check() throws InterruptedException {
        if (cancelRequested) throw new InterruptedException();
    }

    /** The model ships in the APK; ONNX Runtime wants a real file. */
    private File ensureModel() throws Exception {
        File out = new File(getFilesDir(), MODEL_ASSET);
        long assetLen;
        try (android.content.res.AssetFileDescriptor fd = getAssets().openFd(MODEL_ASSET)) {
            assetLen = fd.getLength();
        }
        if (out.isFile() && out.length() == assetLen) return out;
        //noinspection ResultOfMethodCallIgnored
        out.getParentFile().mkdirs();
        File tmp = new File(out.getPath() + ".part");
        try (InputStream in = getAssets().open(MODEL_ASSET); OutputStream o = new FileOutputStream(tmp)) {
            byte[] buf = new byte[1 << 20];
            int n;
            while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
        }
        if (!tmp.renameTo(out)) throw new IllegalStateException("modello non copiato");
        return out;
    }

    static void writeAtomic(File f, String text) throws Exception {
        File tmp = new File(f.getPath() + ".tmp");
        try (OutputStream o = new FileOutputStream(tmp)) {
            o.write(text.getBytes(StandardCharsets.UTF_8));
        }
        if (!tmp.renameTo(f)) throw new IllegalStateException("scrittura fallita");
    }

    static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
