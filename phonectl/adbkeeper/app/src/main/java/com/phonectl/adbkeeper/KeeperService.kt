package com.phonectl.adbkeeper

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log

class KeeperService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var settings: DebugSettings
    private lateinit var connectivity: ConnectivityManager
    private var callbackRegistered = false
    private val recheck = Runnable { settings.recheckWirelessDebugging() }
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            Log.i("adbkeeper", "Wi-Fi available: $network")
            settings.enableWirelessDebugging()
            handler.removeCallbacks(recheck)
            handler.postDelayed(recheck, 4_000L)
        }
    }

    override fun onCreate() {
        super.onCreate()
        val channelId = "keeper"
        val notifications = getSystemService(NotificationManager::class.java)
        notifications.createNotificationChannel(
            NotificationChannel(channelId, "Wireless debugging", NotificationManager.IMPORTANCE_LOW)
        )
        val notification = Notification.Builder(this, channelId)
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setContentTitle("adbkeeper")
            .setContentText("Keeping Wireless debugging enabled on Wi-Fi")
            .setCategory(Notification.CATEGORY_SERVICE)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(1, notification)
        }

        settings = DebugSettings(contentResolver)
        KeeperJobService.schedule(this)
        connectivity = getSystemService(ConnectivityManager::class.java)
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .build()
        try {
            connectivity.registerNetworkCallback(request, networkCallback, handler)
            callbackRegistered = true
        } catch (error: SecurityException) {
            Log.e("adbkeeper", "Cannot monitor Wi-Fi", error)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        settings.enableWirelessDebugging()
        settings.keepAwakeWhilePluggedIn()
        return START_STICKY
    }

    override fun onDestroy() {
        if (callbackRegistered) connectivity.unregisterNetworkCallback(networkCallback)
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
