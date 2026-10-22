package app.stemkitmobile;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;

/**
 * "Sveglia": the alarms the JS side saved (src/lib/alarms.ts), scheduled with
 * AlarmManager.setAlarmClock, so Android rings them exactly, shows them in the
 * status bar and wakes the phone. Each alarm carries the songs it plays as
 * PlayerSpec JSON: AlarmService plays them with the app closed.
 *
 * alarm = {id, hour, minute, days: [1..7 = Mon..Sun] (empty = once), enabled,
 *          label, shuffle, volume 0..1, fadeSec, specs: [PlayerSpec]}
 */
final class AlarmClock {
    static final String ACTION_FIRE = "app.stemkitmobile.ALARM_FIRE";
    private static final String PREFS = "alarms";

    private AlarmClock() {}

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static JSONArray load(Context c) {
        try {
            return new JSONArray(prefs(c).getString("list", "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    static JSONObject find(Context c, String id) {
        JSONArray a = load(c);
        for (int i = 0; i < a.length(); i++) {
            JSONObject x = a.optJSONObject(i);
            if (x != null && id.equals(x.optString("id"))) return x;
        }
        return null;
    }

    static void save(Context c, JSONArray alarms) {
        prefs(c).edit().putString("list", alarms.toString()).apply();
        reschedule(c);
    }

    /** a one-time alarm that has rung is switched off */
    static void disable(Context c, String id) {
        JSONArray a = load(c);
        for (int i = 0; i < a.length(); i++) {
            JSONObject x = a.optJSONObject(i);
            if (x != null && id.equals(x.optString("id"))) {
                try {
                    x.put("enabled", false);
                } catch (Exception ignored) {
                }
            }
        }
        prefs(c).edit().putString("list", a.toString()).apply();
    }

    static void snooze(Context c, String id, int minutes) {
        prefs(c).edit().putString("snoozeId", id).putLong("snoozeAt", System.currentTimeMillis() + minutes * 60_000L).apply();
        reschedule(c);
    }

    /** next time this alarm rings after `now` (ms), or -1 */
    static long next(JSONObject a, long now) {
        if (!a.optBoolean("enabled", true)) return -1;
        JSONArray days = a.optJSONArray("days");
        Calendar cal = Calendar.getInstance();
        cal.setTimeInMillis(now);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        cal.set(Calendar.HOUR_OF_DAY, a.optInt("hour"));
        cal.set(Calendar.MINUTE, a.optInt("minute"));
        for (int i = 0; i < 8; i++) {
            if (cal.getTimeInMillis() > now) {
                if (days == null || days.length() == 0) return cal.getTimeInMillis();
                // Calendar: Sunday = 1 … Saturday = 7; ours: Monday = 1 … Sunday = 7
                int dow = (cal.get(Calendar.DAY_OF_WEEK) + 5) % 7 + 1;
                for (int k = 0; k < days.length(); k++) if (days.optInt(k) == dow) return cal.getTimeInMillis();
            }
            cal.add(Calendar.DAY_OF_MONTH, 1);
        }
        return -1;
    }

    /** the next alarm to ring: {id, at} or null */
    static JSONObject upcoming(Context c) {
        long now = System.currentTimeMillis();
        String best = null;
        long bestAt = Long.MAX_VALUE;
        JSONArray a = load(c);
        for (int i = 0; i < a.length(); i++) {
            JSONObject x = a.optJSONObject(i);
            if (x == null) continue;
            long t = next(x, now);
            if (t > 0 && t < bestAt) {
                bestAt = t;
                best = x.optString("id");
            }
        }
        SharedPreferences p = prefs(c);
        long snoozeAt = p.getLong("snoozeAt", 0);
        if (snoozeAt > now && snoozeAt < bestAt && p.getString("snoozeId", null) != null) {
            bestAt = snoozeAt;
            best = p.getString("snoozeId", null);
        }
        if (best == null) return null;
        try {
            return new JSONObject().put("id", best).put("at", bestAt);
        } catch (Exception e) {
            return null;
        }
    }

    static void reschedule(Context c) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        PendingIntent fire = PendingIntent.getBroadcast(c, 1, new Intent(c, AlarmReceiver.class).setAction(ACTION_FIRE),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        am.cancel(fire);
        JSONObject up = upcoming(c);
        if (up == null) return;
        prefs(c).edit().putString("pendingId", up.optString("id")).apply();
        PendingIntent show = PendingIntent.getActivity(c, 2, new Intent(c, MainActivity.class).putExtra("openAlarms", true),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        try {
            am.setAlarmClock(new AlarmManager.AlarmClockInfo(up.optLong("at"), show), fire);
        } catch (SecurityException e) {
            // exact alarms not allowed: as close as Android lets us
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, up.optLong("at"), fire);
        }
    }

    /** which alarm the pending broadcast is for */
    static String pendingId(Context c) {
        return prefs(c).getString("pendingId", null);
    }

    static void clearSnooze(Context c) {
        prefs(c).edit().remove("snoozeId").remove("snoozeAt").apply();
    }
}
