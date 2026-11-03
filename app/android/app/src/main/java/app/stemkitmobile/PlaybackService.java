package app.stemkitmobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.app.NotificationCompat;

import org.json.JSONObject;

import app.stemkitmobile.audio.Engine;

/**
 * Keeps playback alive in the background like a music app: media
 * notification + lock-screen controls (MediaSession), audio focus (a phone
 * call pauses), and "becoming noisy" (pulling the headphone/amp adapter
 * pauses instead of blasting from the speaker).
 * It is also the app's media browser: Android Auto lists the library through
 * it (AutoLibrary) and plays from it, with the app itself closed.
 */
public class PlaybackService extends androidx.media.MediaBrowserServiceCompat implements Engine.Listener {
    private static final String CHANNEL = "playback";
    private static final int NOTIF_ID = 7;
    static final String ACTION_PLAY = "app.stemkitmobile.PLAY";
    static final String ACTION_PAUSE = "app.stemkitmobile.PAUSE";
    static final String ACTION_NEXT = "app.stemkitmobile.NEXT";
    static final String ACTION_PREV = "app.stemkitmobile.PREV";

    /** next / previous need the app's queue: the plugin forwards these */
    interface Remote {
        void onRemote(String action);
    }

    static volatile Remote remote;
    static volatile String title = "";

    private Engine engine;
    private MediaSessionCompat session;
    private NotificationManager nm;
    private AudioManager am;
    private AudioFocusRequest focusRequest;
    private boolean noisyRegistered;
    private boolean lastPlaying;
    private String lastTitle = "";
    // artwork for the lock screen / quick settings: loaded off the main thread, the last one kept
    private final java.util.concurrent.ExecutorService artLoader = java.util.concurrent.Executors.newSingleThreadExecutor();
    private volatile String artKey; // engine events arrive on its threads
    private volatile android.graphics.Bitmap artBitmap;
    private volatile String metaName = "", metaArtist = "";
    private volatile long metaDur;
    private boolean pausedByFocus;

    private final BroadcastReceiver noisy = new BroadcastReceiver() {
        @Override
        public void onReceive(Context c, Intent i) {
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(i.getAction())) engine.pause();
        }
    };

    private final AudioManager.OnAudioFocusChangeListener focus = change -> {
        if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
            pausedByFocus = engine.isPlaying() && change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT;
            engine.pause();
        } else if (change == AudioManager.AUDIOFOCUS_GAIN && pausedByFocus) {
            pausedByFocus = false;
            engine.play();
        }
    };

    static void start(Context ctx) {
        Intent i = new Intent(ctx, PlaybackService.class);
        try {
            androidx.core.content.ContextCompat.startForegroundService(ctx, i);
        } catch (Exception ignored) {
            // not allowed from the background right now: playback still works in the app
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        engine = Engine.get(this);
        nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Riproduzione", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        session = new MediaSessionCompat(this, "StemKitMobile");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override
            public void onPlay() {
                requestFocus();
                engine.play();
            }

            @Override
            public void onPause() {
                engine.pause();
            }

            @Override
            public void onSkipToNext() {
                Remote r = remote;
                if (r != null) r.onRemote("next");
                else engine.next(); // the app isn't running (Android Auto started us)
            }

            @Override
            public void onSkipToPrevious() {
                Remote r = remote;
                if (r != null) r.onRemote("prev");
                else engine.prev();
            }

            @Override
            public void onPlayFromMediaId(String mediaId, android.os.Bundle extras) {
                autoPool.execute(() -> {
                    try {
                        playStart(library.start(mediaId));
                    } catch (Exception e) {
                        android.util.Log.w("StemKitPlayback", "play " + mediaId, e);
                    }
                });
            }

            @Override
            public void onPlayFromSearch(String query, android.os.Bundle extras) {
                autoPool.execute(() -> {
                    try {
                        playStart(library.search(query));
                    } catch (Exception e) {
                        android.util.Log.w("StemKitPlayback", "search " + query, e);
                    }
                });
            }

            @Override
            public void onSeekTo(long ms) {
                engine.seek(ms / 1000.0);
            }
        });
        session.setActive(true);
        setSessionToken(session.getSessionToken());
        library = new AutoLibrary(this);
        engine.addListener(this);
        try {
            startForegroundCompat(build(engine.isPlaying()));
        } catch (Exception e) {
            // created by a media browser (Android Auto) with the app in background: foreground when playing
            android.util.Log.w("StemKitPlayback", "foreground later", e);
        }
    }

    // ------------------------------------------------------------ media browser (Android Auto)

    private final java.util.concurrent.ExecutorService autoPool = java.util.concurrent.Executors.newSingleThreadExecutor();
    private AutoLibrary library;
    // who may browse the library: the car, the system's media controls, the assistant, this app
    private static final java.util.Set<String> BROWSERS = new java.util.HashSet<>(java.util.Arrays.asList(
        "com.google.android.projection.gearhead", "com.google.android.carassistant", "com.google.android.googlequicksearchbox",
        "com.google.android.apps.automotive.media", "com.android.systemui", "android", "com.google.android.wearable.app"));

    @Override
    public BrowserRoot onGetRoot(String clientPackageName, int clientUid, android.os.Bundle rootHints) {
        boolean ok = BROWSERS.contains(clientPackageName) || getPackageName().equals(clientPackageName);
        return new BrowserRoot(ok ? AutoLibrary.ROOT : AutoLibrary.EMPTY, AutoLibrary.rootExtras());
    }

    @Override
    public void onLoadChildren(String parentId, Result<java.util.List<android.support.v4.media.MediaBrowserCompat.MediaItem>> result) {
        if (AutoLibrary.EMPTY.equals(parentId)) {
            result.sendResult(new java.util.ArrayList<>());
            return;
        }
        result.detach();
        autoPool.execute(() -> result.sendResult(library.children(parentId)));
    }

    /** a list chosen in the car: plays natively, the app shows it when it opens */
    private void playStart(AutoLibrary.Start st) {
        if (st == null) return;
        new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
            requestFocus();
            title = st.song.title;
            try {
                startForegroundCompat(build(true));
            } catch (Exception ignored) {
            }
            engine.playFrom(st.song, st.next, st.previous, st.ids, st.index, st.name);
        });
    }

    private void startForegroundCompat(Notification n) {
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(NOTIF_ID, n);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String a = intent != null ? intent.getAction() : null;
        if (ACTION_PLAY.equals(a)) {
            requestFocus();
            engine.play();
        } else if (ACTION_PAUSE.equals(a)) {
            engine.pause();
        } else if (ACTION_NEXT.equals(a) || ACTION_PREV.equals(a)) {
            Remote r = remote;
            if (r != null) r.onRemote(ACTION_NEXT.equals(a) ? "next" : "prev");
        } else {
            requestFocus();
        }
        return START_NOT_STICKY;
    }

    void requestFocus() {
        if (focusRequest == null) {
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build())
                .setOnAudioFocusChangeListener(focus)
                .build();
        }
        am.requestAudioFocus(focusRequest);
    }

    @Override
    public void onEvent(JSONObject e) {
        String type = e.optString("type");
        if (!"state".equals(type) && !"tick".equals(type)) return;
        boolean playing = e.optBoolean("playing");
        String t = e.optString("title", "");
        if (t.isEmpty()) t = title;
        long posMs = Math.round(e.optDouble("pos", 0) * 1000);
        long durMs = Math.round(e.optDouble("dur", 0) * 1000);
        session.setPlaybackState(new PlaybackStateCompat.Builder()
            .setActions(PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE | PlaybackStateCompat.ACTION_PLAY_PAUSE
                | PlaybackStateCompat.ACTION_SKIP_TO_NEXT | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS | PlaybackStateCompat.ACTION_SEEK_TO
                | PlaybackStateCompat.ACTION_PLAY_FROM_MEDIA_ID | PlaybackStateCompat.ACTION_PLAY_FROM_SEARCH)
            .setState(playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED, posMs, playing ? 1f : 0f)
            .build());
        if (!t.equals(lastTitle) || "state".equals(type)) {
            String name = e.optString("name", "");
            metaName = name.isEmpty() ? t : name;
            metaArtist = e.optString("artist", "");
            metaDur = durMs;
            String art = e.optString("art", "");
            if (!art.equals(artKey == null ? "" : artKey)) {
                artKey = art;
                artBitmap = null;
                if (!art.isEmpty()) loadArt(art);
            }
            publishMetadata();
        }
        if (playing != lastPlaying || !t.equals(lastTitle)) {
            lastPlaying = playing;
            lastTitle = t;
            nm.notify(NOTIF_ID, build(playing));
            if (playing) registerNoisy();
            else unregisterNoisy();
        }
    }

    private void publishMetadata() {
        MediaMetadataCompat.Builder b = new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, metaName)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, metaArtist.isEmpty() ? "OpenSpoty" : metaArtist)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, metaDur);
        if (artBitmap != null) b.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, artBitmap);
        session.setMetadata(b.build());
    }

    /** the artwork, at most 512 px, then the metadata and the notification again */
    private void loadArt(String art) {
        artLoader.execute(() -> {
            android.graphics.Bitmap bm = null;
            try {
                byte[] data;
                if (art.startsWith("https://")) {
                    java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(art).openConnection();
                    c.setConnectTimeout(8000);
                    c.setReadTimeout(8000);
                    try (java.io.InputStream in = c.getInputStream()) {
                        data = in.readAllBytes();
                    } finally {
                        c.disconnect();
                    }
                } else {
                    data = java.nio.file.Files.readAllBytes(new java.io.File(art).toPath());
                }
                android.graphics.BitmapFactory.Options o = new android.graphics.BitmapFactory.Options();
                o.inJustDecodeBounds = true;
                android.graphics.BitmapFactory.decodeByteArray(data, 0, data.length, o);
                int sample = 1;
                while (Math.max(o.outWidth, o.outHeight) / (sample * 2) >= 512) sample *= 2;
                o = new android.graphics.BitmapFactory.Options();
                o.inSampleSize = sample;
                bm = android.graphics.BitmapFactory.decodeByteArray(data, 0, data.length, o);
            } catch (Exception ex) {
                android.util.Log.w("StemKitPlayback", "artwork " + art, ex);
            }
            final android.graphics.Bitmap got = bm;
            new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
                if (got == null || !art.equals(artKey)) return; // a newer song meanwhile
                artBitmap = got;
                publishMetadata();
                nm.notify(NOTIF_ID, build(lastPlaying));
            });
        });
    }

    private void registerNoisy() {
        if (noisyRegistered) return;
        IntentFilter f = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(noisy, f, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(noisy, f);
        noisyRegistered = true;
    }

    private void unregisterNoisy() {
        if (!noisyRegistered) return;
        try {
            unregisterReceiver(noisy);
        } catch (Exception ignored) {
        }
        noisyRegistered = false;
    }

    private PendingIntent action(String a, int code) {
        Intent i = new Intent(this, PlaybackService.class).setAction(a);
        return PendingIntent.getService(this, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification build(boolean playing) {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(!metaName.isEmpty() ? metaName : title.isEmpty() ? "OpenSpoty" : title)
            .setContentText(!metaArtist.isEmpty() ? metaArtist : playing ? "In riproduzione" : "In pausa")
            .setLargeIcon(artBitmap)
            .setContentIntent(content)
            .setOngoing(playing)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(android.R.drawable.ic_media_previous, "Precedente", action(ACTION_PREV, 1))
            .addAction(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                playing ? "Pausa" : "Play", action(playing ? ACTION_PAUSE : ACTION_PLAY, 2))
            .addAction(android.R.drawable.ic_media_next, "Successiva", action(ACTION_NEXT, 3))
            .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                .setMediaSession(session.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2))
            .build();
    }

    @Override
    public void onDestroy() {
        engine.removeListener(this);
        artLoader.shutdownNow();
        autoPool.shutdownNow();
        unregisterNoisy();
        if (focusRequest != null) am.abandonAudioFocusRequest(focusRequest);
        session.release();
        super.onDestroy();
    }

}
