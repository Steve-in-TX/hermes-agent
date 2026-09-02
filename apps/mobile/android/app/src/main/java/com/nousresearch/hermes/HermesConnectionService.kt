package com.nousresearch.hermes

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Foreground service that keeps the process — and with it the WebView's
 * gateway socket — alive while the app is in the background, behind a
 * persistent "Connected to <gateway>" notification.
 *
 * It holds no socket itself: the JS controller owns the connection and the
 * WebView keeps running (Capacitor never pauses it). The service only stops
 * Android from killing the process between approvals.
 *
 * Type `dataSync` (Android 14+ caps it at 6 h per 24 h; `remoteMessaging`
 * is the alternative if that bites). Started/stopped from HermesShellPlugin.
 */
class HermesConnectionService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    /**
     * Android 15+: dataSync services get at most 6 h per 24 h. Stop cleanly;
     * the plugin starts the service again on the next connect / foreground.
     */
    override fun onTimeout(startId: Int, fgsType: Int) {
        stopSelf()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val label = intent?.getStringExtra(EXTRA_LABEL)?.takeIf { it.isNotBlank() } ?: "gateway"
        val notification = buildNotification(label)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        return START_NOT_STICKY
    }

    private fun buildNotification(label: String): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, HermesShellPlugin.CHANNEL_CONNECTION)
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setContentTitle("Connected to $label")
            .setContentText("Approvals and questions from the agent will show up here.")
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(open)
            .build()
    }

    companion object {
        const val NOTIFICATION_ID = 1001
        const val EXTRA_LABEL = "label"
    }
}
