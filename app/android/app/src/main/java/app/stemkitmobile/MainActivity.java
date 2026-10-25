package app.stemkitmobile;

import android.content.Intent;
import android.os.Bundle;
import android.net.http.SslError;
import android.webkit.SslErrorHandler;
import android.webkit.WebView;
import android.os.Build;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

import java.security.cert.X509Certificate;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(StemKitNativePlugin.class);
        registerPlugin(StemPlayerPlugin.class);
        registerPlugin(AlarmsPlugin.class);
        super.onCreate(savedInstanceState);
        if (bridge != null) {
            bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
                @Override
                public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                    if (Build.VERSION.SDK_INT >= 29 && error != null && error.getCertificate() != null) {
                        X509Certificate certificate = error.getCertificate().getX509Certificate();
                        String expected = getSharedPreferences("openspoty", MODE_PRIVATE)
                            .getString("bridgeFingerprint", "");
                        if (certificate != null && BridgeTlsPin.matches(certificate, expected)) {
                            handler.proceed();
                            return;
                        }
                    }
                    handler.cancel();
                }
            });
        }
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
