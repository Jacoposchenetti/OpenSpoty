package app.stemkitmobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(StemKitNativePlugin.class);
        registerPlugin(StemPlayerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
