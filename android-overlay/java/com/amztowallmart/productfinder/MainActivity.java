package com.amztowallmart.productfinder;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AWNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
