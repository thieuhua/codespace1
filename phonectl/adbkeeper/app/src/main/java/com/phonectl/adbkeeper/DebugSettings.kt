package com.phonectl.adbkeeper

import android.content.ContentResolver
import android.provider.Settings
import android.util.Log

internal class DebugSettings(private val resolver: ContentResolver) {
    fun enableWirelessDebugging() = write("adb_wifi_enabled", 1)

    fun keepAwakeWhilePluggedIn() = write("stay_on_while_plugged_in", 7)

    fun recheckWirelessDebugging() {
        try {
            val enabled = Settings.Global.getInt(resolver, "adb_wifi_enabled", 0)
            Log.i("adbkeeper", "Wi-Fi recheck: adb_wifi_enabled=$enabled")
            if (enabled == 0) enableWirelessDebugging()
        } catch (error: SecurityException) {
            Log.e("adbkeeper", "Cannot read adb_wifi_enabled", error)
        }
    }

    private fun write(name: String, value: Int) {
        try {
            if (Settings.Global.putInt(resolver, name, value)) {
                Log.i("adbkeeper", "$name=$value")
            } else {
                Log.w("adbkeeper", "Settings provider rejected $name=$value")
            }
        } catch (error: SecurityException) {
            Log.e("adbkeeper", "Cannot write $name; grant WRITE_SECURE_SETTINGS via ADB", error)
        }
    }
}
