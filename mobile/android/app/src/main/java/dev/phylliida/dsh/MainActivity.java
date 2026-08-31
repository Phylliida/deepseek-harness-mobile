package dev.phylliida.dsh;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DshMobilePlugin.class);
        super.onCreate(savedInstanceState);
        requestBatteryOptimizationExemption();
    }

    /**
     * Battery optimization is the main way the system reaps the foreground
     * service despite its wake lock; ask once on first launch to exempt the
     * app. The system dialog is idempotent, so skip when already exempt.
     */
    private void requestBatteryOptimizationExemption() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm.isIgnoringBatteryOptimizations(getPackageName())) return;
        Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:" + getPackageName()));
        startActivity(intent);
    }
}
