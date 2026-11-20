package com.phonectl.adbkeeper

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_LOCKED_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED -> {
                Log.i("adbkeeper", "Received ${intent.action}")
                KeeperJobService.schedule(context)
                try {
                    context.startForegroundService(Intent(context, KeeperService::class.java))
                } catch (error: IllegalStateException) {
                    Log.e("adbkeeper", "ROM refused foreground start; keeper job remains scheduled", error)
                } catch (error: SecurityException) {
                    Log.e("adbkeeper", "Foreground start permission denied", error)
                }
            }
        }
    }
}
