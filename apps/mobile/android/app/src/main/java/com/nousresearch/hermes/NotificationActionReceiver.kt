package com.nousresearch.hermes

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat

/**
 * Receives the Approve / Deny taps on an approval notification.
 *
 * Only `once` and `deny` are ever offered from a notification: `always`
 * rewrites the gateway's config and needs the in-app confirm step, and sudo
 * or secret prompts are never answerable here at all. If the plugin (and so
 * the JS controller) is alive the choice is emitted to it; otherwise the
 * activity is relaunched with the choice as extras and the plugin delivers
 * it once the WebView is back.
 */
class NotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val sessionId = intent.getStringExtra(HermesShellPlugin.EXTRA_SESSION_ID) ?: return
        val requestId = intent.getStringExtra(HermesShellPlugin.EXTRA_REQUEST_ID) ?: return
        val choice = intent.getStringExtra(HermesShellPlugin.EXTRA_CHOICE) ?: return
        if (choice != "once" && choice != "deny") return

        NotificationManagerCompat.from(context).cancel(HermesShellPlugin.approvalNotificationId(requestId))

        val plugin = HermesShellPlugin.instance
        if (plugin != null) {
            plugin.emitApprovalAction(sessionId, requestId, choice)
            return
        }
        val launch = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(HermesShellPlugin.EXTRA_SESSION_ID, sessionId)
            .putExtra(HermesShellPlugin.EXTRA_REQUEST_ID, requestId)
            .putExtra(HermesShellPlugin.EXTRA_CHOICE, choice)
        context.startActivity(launch)
    }
}
