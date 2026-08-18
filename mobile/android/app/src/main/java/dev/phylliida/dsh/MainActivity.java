package dev.phylliida.dsh;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DshMobilePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
