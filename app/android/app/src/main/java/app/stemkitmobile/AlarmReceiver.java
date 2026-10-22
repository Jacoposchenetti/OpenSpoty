package app.stemkitmobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** The alarm time came (AlarmClock), or the phone restarted: alarms are scheduled again. */
public class AlarmReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent.getAction();
        if (AlarmClock.ACTION_FIRE.equals(action)) {
            String id = AlarmClock.pendingId(ctx);
            AlarmClock.clearSnooze(ctx);
            if (id != null) AlarmService.ring(ctx, id);
            AlarmClock.reschedule(ctx);
        } else {
            AlarmClock.reschedule(ctx); // BOOT_COMPLETED, time or time zone changed, app updated
        }
    }
}
