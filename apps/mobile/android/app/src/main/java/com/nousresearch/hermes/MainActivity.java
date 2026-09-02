package com.nousresearch.hermes;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Native transport for the bundled dashboard: every REST call and
        // WebSocket the SPA makes goes through these (see
        // web/src/lib/transport/capacitor.ts). Register before the bridge
        // boots so they exist when the web layer calls registerPlugin.
        registerPlugin(HermesHttpPlugin.class);
        registerPlugin(HermesSocketPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
