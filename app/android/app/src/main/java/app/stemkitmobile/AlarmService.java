package app.stemkitmobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import app.stemkitmobile.audio.Engine;

/**
 * A ringing alarm: plays the alarm's music with the native engine (also with
 * the app closed and the screen locked), rising slowly from silence, with a
 * full-screen notification "Stop / Posticipa". If the music doesn't start
 * (offline and only streamed songs), the phone's alarm sound rings instead.
 */
public class AlarmService extends Service {
    private static final String CHANNEL = "alarm";
    private static final int NOTIF_ID = 7;
    static final String ACTION_STOP = "app.stemkitmobile.ALARM_STOP";
    static final String ACTION_SNOOZE = "app.stemkitmobile.ALARM_SNOOZE";

    /** the alarm ringing now (read by the app's ringing screen), or null */
    static volatile JSONObject ringing;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private Engine engine;
    private Ringtone fallback;
    private int savedVolume = -1;
    private AudioManager am;

    static void ring(Context ctx, String id) {
        Intent i = new Intent(ctx, AlarmService.class).putExtra("id", id);
        androidx.core.content.ContextCompat.startForegroundService(ctx, i);
    }

    static void control(Context ctx, String action) {
        ctx.startService(new Intent(ctx, AlarmService.class).setAction(action));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action) || ACTION_SNOOZE.equals(action)) {
            JSONObject r = ringing;
            if (ACTION_SNOOZE.equals(action) && r != null) AlarmClock.snooze(this, r.optString("id"), r.optInt("snooze", 9));
            finish();
            return START_NOT_STICKY;
        }
        String id = intent != null ? intent.getStringExtra("id") : null;
        JSONObject alarm = id != null ? AlarmClock.find(this, id) : null;
        if (alarm == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        start(alarm);
        return START_NOT_STICKY;
    }

    private void start(JSONObject alarm) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Sveglia", NotificationManager.IMPORTANCE_HIGH);
            ch.setSound(null, null); // the music is the sound
            ch.setBypassDnd(true);
            nm.createNotificationChannel(ch);
        }
        try {
            ringing = new JSONObject().put("id", alarm.optString("id")).put("label", alarm.optString("label"))
                .put("hour", alarm.optInt("hour")).put("minute", alarm.optInt("minute")).put("snooze", alarm.optInt("snooze", 9));
        } catch (Exception ignored) {
        }
        Notification n = notification(alarm);
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(NOTIF_ID, n);

        JSONArray days = alarm.optJSONArray("days");
        if (days == null || days.length() == 0) AlarmClock.disable(this, alarm.optString("id"));

        // volume: the alarm's own level, given back when it stops
        am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        savedVolume = am.getStreamVolume(AudioManager.STREAM_MUSIC);
        am.setStreamVolume(AudioManager.STREAM_MUSIC, Math.max(1, Math.round(max * (float) alarm.optDouble("volume", 0.6))), 0);

        // the music: the alarm's songs, shuffled if asked, fading in
        List<Engine.Spec> specs = new ArrayList<>();
        JSONArray a = alarm.optJSONArray("specs");
        for (int i = 0; a != null && i < a.length(); i++) {
            JSONObject s = a.optJSONObject(i);
            if (s != null) specs.add(StemPlayerPlugin.specOf(getFilesDir(), s));
        }
        if (alarm.optBoolean("shuffle")) Collections.shuffle(specs);
        // when they are over: similar songs (streamed), the same again, or silence
        String after = alarm.optString("after", "repeat");
        JSONArray more = alarm.optJSONArray("more");
        if ("similar".equals(after)) {
            for (int i = 0; more != null && i < more.length(); i++) {
                JSONObject s = more.optJSONObject(i);
                if (s != null) specs.add(StemPlayerPlugin.specOf(getFilesDir(), s));
            }
        }
        boolean repeatOne = "repeat".equals(after) && specs.size() == 1;
        if ("repeat".equals(after) && specs.size() > 1) {
            List<Engine.Spec> once = new ArrayList<>(specs);
            while (specs.size() < 60) specs.addAll(once); // longer than the 30 minutes it rings at most
        }
        if (specs.isEmpty()) {
            playFallback();
        } else {
            engine = Engine.get(this);
            Engine.Spec first = specs.get(0);
            JSONObject mix = first.mix != null ? first.mix : new JSONObject();
            try {
                first.mix = new JSONObject(mix.toString()).put("master", 0.02);
            } catch (Exception ignored) {
            }
            first.countIn = false;
            engine.load(first, true);
            engine.setUpcoming(specs.subList(1, specs.size()), null);
            engine.setAutoAdvance(true);
            engine.setRepeatOne(repeatOne);
            fadeIn(mix, Math.max(1, alarm.optInt("fadeSec", 45)));
            // nothing playing after a while (offline, broken file): ring the phone's alarm sound
            handler.postDelayed(() -> {
                if (engine != null && !engine.isPlaying()) playFallback();
            }, 25_000);
        }
        // nobody stops it: it gives up after 30 minutes
        handler.postDelayed(this::finish, 30 * 60_000);
    }

    private void fadeIn(JSONObject mix, int seconds) {
        final long start = System.currentTimeMillis();
        handler.post(new Runnable() {
            @Override
            public void run() {
                if (engine == null) return;
                float f = Math.min(1f, (System.currentTimeMillis() - start) / (seconds * 1000f));
                try {
                    engine.setMix(new JSONObject(mix.toString()).put("master", 0.02 + 0.98 * f * f));
                } catch (Exception ignored) {
                }
                if (f < 1f) handler.postDelayed(this, 500);
            }
        });
    }

    private void playFallback() {
        if (fallback != null) return;
        if (engine != null) engine.stop();
        fallback = RingtoneManager.getRingtone(this, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM));
        if (fallback == null) return;
        fallback.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build());
        if (Build.VERSION.SDK_INT >= 28) fallback.setLooping(true);
        fallback.play();
    }

    private Notification notification(JSONObject alarm) {
        Intent open = new Intent(this, MainActivity.class).putExtra("alarmRinging", true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent full = PendingIntent.getActivity(this, 3, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 4, new Intent(this, AlarmService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent snooze = PendingIntent.getService(this, 5, new Intent(this, AlarmService.class).setAction(ACTION_SNOOZE), PendingIntent.FLAG_IMMUTABLE);
        String time = String.format(java.util.Locale.ITALY, "%02d:%02d", alarm.optInt("hour"), alarm.optInt("minute"));
        String label = alarm.optString("label");
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle("Sveglia " + time)
            .setContentText(label.isEmpty() ? "OpenSpoty" : label)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setFullScreenIntent(full, true)
            .setContentIntent(full)
            .setOngoing(true)
            .addAction(0, "Posticipa " + alarm.optInt("snooze", 9) + " min", snooze)
            .addAction(0, "Stop", stop)
            .build();
    }

    private void finish() {
        handler.removeCallbacksAndMessages(null);
        if (engine != null) {
            engine.setRepeatOne(false); // the alarm's own setting, not the player's
            engine.pause();
            engine = null;
        }
        if (fallback != null) {
            fallback.stop();
            fallback = null;
        }
        if (am != null && savedVolume >= 0) am.setStreamVolume(AudioManager.STREAM_MUSIC, savedVolume, 0);
        savedVolume = -1;
        ringing = null;
        AlarmClock.reschedule(this);
        stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
