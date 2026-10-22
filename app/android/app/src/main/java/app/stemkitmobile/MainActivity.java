package app.stemkitmobile;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(StemKitNativePlugin.class);
        registerPlugin(StemPlayerPlugin.class);
        registerPlugin(AlarmsPlugin.class);
        super.onCreate(savedInstanceState);
        overLockScreen(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        overLockScreen(intent);
    }

    /** a ringing alarm shows its screen over the lock screen and turns the display on */
    private void overLockScreen(Intent intent) {
        boolean alarm = intent != null && intent.getBooleanExtra("alarmRinging", false);
        setShowWhenLocked(alarm);
        setTurnScreenOn(alarm);
    }
}
