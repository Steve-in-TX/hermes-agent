package com.nousresearch.hermes

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.speech.RecognizerIntent
import androidx.activity.result.ActivityResult
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import org.json.JSONObject

/**
 * `HermesShell` — the native affordances that make this an app rather than a
 * bookmark (plan M5):
 *
 *  - foreground service ("Connected to <gateway>") so the process, and the
 *    WebView's socket, survive in the background;
 *  - approval notifications with Approve (= `once`) / Deny actions, and a
 *    "turn finished" notification, raised by JS when the app is hidden;
 *  - `networkAvailable` events from ConnectivityManager so JS reconnects
 *    the moment Wi-Fi returns instead of waiting out a cellular timeout;
 *  - share target (`ACTION_SEND` text/plain) → `shareText` event;
 *  - dictation via the system speech recogniser.
 *
 * Never answers sudo/secret prompts and never offers `always` from a
 * notification.
 */
@CapacitorPlugin(
    name = "HermesShell",
    permissions = [Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])],
)
class HermesShellPlugin : Plugin() {
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun load() {
        instance = this
        createChannels()
        registerNetworkCallback()
        activity.intent?.let { deliverIntent(it) }
    }

    override fun handleOnDestroy() {
        if (instance === this) instance = null
        networkCallback?.let {
            runCatching { connectivityManager().unregisterNetworkCallback(it) }
        }
        networkCallback = null
    }

    override fun handleOnNewIntent(intent: Intent) {
        deliverIntent(intent)
    }

    // ── permissions ─────────────────────────────────────────────────

    @PluginMethod
    fun requestNotificationPermission(call: PluginCall) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve(JSObject().put("granted", NotificationManagerCompat.from(context).areNotificationsEnabled()))
            return
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionCallback")
    }

    @PermissionCallback
    fun notificationPermissionCallback(call: PluginCall) {
        call.resolve(JSObject().put("granted", getPermissionState("notifications") == PermissionState.GRANTED))
    }

    // ── foreground service ──────────────────────────────────────────

    @PluginMethod
    fun startForeground(call: PluginCall) {
        val label = call.getString("label") ?: "gateway"
        val intent = Intent(context, HermesConnectionService::class.java).putExtra(HermesConnectionService.EXTRA_LABEL, label)
        try {
            ContextCompat.startForegroundService(context, intent)
            call.resolve()
        } catch (e: Exception) {
            // Background-start restrictions etc. — the app still works, it
            // just is not shielded from process death.
            call.reject("foreground service unavailable: ${e.message}", "unavailable")
        }
    }

    @PluginMethod
    fun stopForeground(call: PluginCall) {
        context.stopService(Intent(context, HermesConnectionService::class.java))
        call.resolve()
    }

    // ── notifications ───────────────────────────────────────────────

    @PluginMethod
    fun notifyApproval(call: PluginCall) {
        val sessionId = call.getString("sessionId") ?: return call.reject("sessionId required")
        val requestId = call.getString("requestId") ?: return call.reject("requestId required")
        val command = call.getString("command") ?: ""
        val description = call.getString("description") ?: "dangerous command"
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) {
            call.resolve(JSObject().put("shown", false))
            return
        }
        val id = approvalNotificationId(requestId)
        val builder = NotificationCompat.Builder(context, CHANNEL_APPROVALS)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle("Approval required: $description")
            .setContentText(command.ifBlank { "The agent wants to run a command." })
            .setStyle(NotificationCompat.BigTextStyle().bigText(command))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(openAppIntent(id))
            .addAction(0, "Approve once", actionIntent(id, sessionId, requestId, "once"))
            .addAction(0, "Deny", actionIntent(id, sessionId, requestId, "deny"))
        NotificationManagerCompat.from(context).notify(id, builder.build())
        call.resolve(JSObject().put("shown", true).put("id", id))
    }

    @PluginMethod
    fun notifyTurnComplete(call: PluginCall) {
        val sessionId = call.getString("sessionId") ?: return call.reject("sessionId required")
        val text = call.getString("text") ?: ""
        val title = call.getString("title") ?: "Hermes finished"
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) {
            call.resolve(JSObject().put("shown", false))
            return
        }
        val id = turnNotificationId(sessionId)
        val builder = NotificationCompat.Builder(context, CHANNEL_TURNS)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(text.ifBlank { "The agent's turn is complete." })
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(openAppIntent(id))
        NotificationManagerCompat.from(context).notify(id, builder.build())
        call.resolve(JSObject().put("shown", true).put("id", id))
    }

    @PluginMethod
    fun cancelApprovalNotification(call: PluginCall) {
        val requestId = call.getString("requestId") ?: return call.reject("requestId required")
        NotificationManagerCompat.from(context).cancel(approvalNotificationId(requestId))
        call.resolve()
    }

    /** Called by NotificationActionReceiver (or from a relaunch intent). */
    fun emitApprovalAction(sessionId: String, requestId: String, choice: String) {
        val data = JSObject().put("sessionId", sessionId).put("requestId", requestId).put("choice", choice)
        notifyListeners("approvalAction", data, true)
    }

    private fun actionIntent(id: Int, sessionId: String, requestId: String, choice: String): PendingIntent {
        val intent = Intent(context, NotificationActionReceiver::class.java)
            .setAction("$ACTION_APPROVAL.$choice")
            .putExtra(EXTRA_SESSION_ID, sessionId)
            .putExtra(EXTRA_REQUEST_ID, requestId)
            .putExtra(EXTRA_CHOICE, choice)
        val requestCode = id * 2 + if (choice == "deny") 1 else 0
        return PendingIntent.getBroadcast(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun openAppIntent(id: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context, id, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_CONNECTION, "Gateway connection", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while the app keeps its connection to a Hermes gateway alive."
                setShowBadge(false)
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_APPROVALS, "Approvals", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "The agent is waiting for you to approve or deny a command."
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_TURNS, "Replies", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "The agent finished a turn while the app was in the background."
            },
        )
    }

    // ── network ─────────────────────────────────────────────────────

    private fun connectivityManager(): ConnectivityManager =
        context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    private fun registerNetworkCallback() {
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                notifyListeners("networkAvailable", JSObject(), false)
            }
        }
        runCatching { connectivityManager().registerDefaultNetworkCallback(callback) }
            .onSuccess { networkCallback = callback }
    }

    // ── share target + relaunch-delivered actions ───────────────────

    private fun deliverIntent(intent: Intent) {
        if (intent.action == Intent.ACTION_SEND && intent.type?.startsWith("text/") == true) {
            val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return
            notifyListeners("shareText", JSObject().put("text", text), true)
            intent.action = null // deliver once
            return
        }
        val requestId = intent.getStringExtra(EXTRA_REQUEST_ID)
        val sessionId = intent.getStringExtra(EXTRA_SESSION_ID)
        val choice = intent.getStringExtra(EXTRA_CHOICE)
        if (requestId != null && sessionId != null && choice != null) {
            emitApprovalAction(sessionId, requestId, choice)
            intent.removeExtra(EXTRA_REQUEST_ID)
        }
    }

    // ── dictation ───────────────────────────────────────────────────

    @PluginMethod
    fun startDictation(call: PluginCall) {
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PROMPT, "Message the agent")
        if (intent.resolveActivity(context.packageManager) == null) {
            call.reject("No speech recogniser available", "unavailable")
            return
        }
        startActivityForResult(call, intent, "dictationResult")
    }

    @ActivityCallback
    fun dictationResult(call: PluginCall, result: ActivityResult) {
        val text = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
        val ret = JSObject()
        ret.put("text", text ?: JSONObject.NULL)
        call.resolve(ret)
    }

    companion object {
        @Volatile
        var instance: HermesShellPlugin? = null

        const val CHANNEL_CONNECTION = "hermes_connection"
        const val CHANNEL_APPROVALS = "hermes_approvals"
        const val CHANNEL_TURNS = "hermes_turns"
        const val ACTION_APPROVAL = "com.nousresearch.hermes.APPROVAL"
        const val EXTRA_SESSION_ID = "hermes.sessionId"
        const val EXTRA_REQUEST_ID = "hermes.requestId"
        const val EXTRA_CHOICE = "hermes.choice"

        fun approvalNotificationId(requestId: String): Int = 2000 + (requestId.hashCode() and 0x7fffff)
        fun turnNotificationId(sessionId: String): Int = 3000 + (sessionId.hashCode() and 0x7fffff)
    }
}
