package app.stemkitmobile;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

/** JS side: src/lib/alarms.ts ("Sveglia"). */
@CapacitorPlugin(name = "Alarms")
public class AlarmsPlugin extends Plugin {

    /** all the alarms, each with the songs it plays: replaces what was saved and reschedules */
    @PluginMethod
    public void save(PluginCall call) {
        try {
            JSArray alarms = call.getArray("alarms", new JSArray());
            AlarmClock.save(getContext(), alarms);
            call.resolve(state());
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void state(PluginCall call) {
        try {
            call.resolve(state());
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    private JSObject state() throws Exception {
        JSObject r = new JSObject();
        JSONObject up = AlarmClock.upcoming(getContext());
        r.put("next", up != null ? JSObject.fromJSONObject(up) : JSONObject.NULL);
        JSONObject ring = AlarmService.ringing;
        r.put("ringing", ring != null ? JSObject.fromJSONObject(ring) : JSONObject.NULL);
        boolean full = true;
        if (Build.VERSION.SDK_INT >= 34) {
            NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            full = nm.canUseFullScreenIntent();
        }
        r.put("fullScreen", full);
        return r;
    }

    @PluginMethod
    public void stop(PluginCall call) {
        AlarmService.control(getContext(), AlarmService.ACTION_STOP);
        call.resolve();
    }

    @PluginMethod
    public void snooze(PluginCall call) {
        AlarmService.control(getContext(), AlarmService.ACTION_SNOOZE);
        call.resolve();
    }

    /** Android 14+: the alarm can only cover the lock screen if the user allows it */
    @PluginMethod
    public void allowFullScreen(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 34) {
            Intent i = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getContext().getPackageName()))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        }
        call.resolve();
    }
}
