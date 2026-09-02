package com.nousresearch.hermes

import android.content.Intent
import android.net.Uri
import android.util.Base64
import androidx.browser.customtabs.CustomTabsIntent
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.SocketTimeoutException
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicReference
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * `HermesAuth` — RFC 8252 (OAuth 2.0 for Native Apps) sign-in to a gated
 * Hermes gateway, plus the encrypted session store and token refresh.
 *
 * Flow (`login`):
 *  1. Generate a PKCE pair (S256) and a CSRF `state` here — the verifier
 *     never leaves this process.
 *  2. Choose the redirect: a loopback `ServerSocket` on 127.0.0.1:0 (works
 *     against every gateway), or the app's private-use scheme
 *     `com.nousresearch.hermes:/oauth2redirect` when the gateway advertises
 *     `native_app_scheme` (no listener; the intent filter delivers the code).
 *  3. Open `<gateway>/auth/native/authorize?…` in a Chrome Custom Tab (system
 *     browser: OS password managers autofill; cookies stay out of the app).
 *  4. Catch `?code=&state=`, verify `state`, POST `/auth/native/token` with
 *     the verifier, store the tokens (Keystore-backed), resolve to JS with
 *     the access token only.
 *
 * `refresh` honours the gateway's 401-vs-503 split: 401 `session_expired`
 * wipes the store and rejects with code "session_expired"; a 503 or a network
 * failure rejects with "unavailable" and keeps the session — a transient IDP
 * outage must never log the user out.
 */
@CapacitorPlugin(name = "HermesAuth")
class HermesAuthPlugin : Plugin() {
    private lateinit var store: HermesTokenStore

    /** In-flight login, if any. Only one at a time. */
    private class Pending(
        val call: PluginCall,
        val origin: String,
        val basePath: String,
        val verifier: String,
        val state: String,
        val mode: String,
        val listener: ServerSocket?,
    ) {
        val codeReceived = AtomicReference<String?>(null)
    }

    private val pending = AtomicReference<Pending?>(null)

    override fun load() {
        store = HermesTokenStore(context)
    }

    // ── session ─────────────────────────────────────────────────────

    @PluginMethod
    fun getSession(call: PluginCall) {
        val session = store.load()
        val ret = JSObject()
        ret.put("session", session?.toJs() ?: JSONObject.NULL)
        call.resolve(ret)
    }

    /** Manual path (paste a token): keep it in the same encrypted store. */
    @PluginMethod
    fun setSession(call: PluginCall) {
        val origin = call.getString("origin")
        val access = call.getString("accessToken")
        if (origin.isNullOrEmpty() || access.isNullOrEmpty()) {
            call.reject("origin and accessToken required", "failed")
            return
        }
        val session = HermesTokenStore.Session(
            origin = origin,
            basePath = call.getString("basePath") ?: "",
            accessToken = access,
            refreshToken = call.getString("refreshToken") ?: "",
            expiresAt = call.getLong("expiresAt") ?: 0L,
            userId = call.getString("userId") ?: "",
            provider = call.getString("provider") ?: "",
        )
        store.save(session)
        val ret = JSObject()
        ret.put("session", session.toJs())
        call.resolve(ret)
    }

    @PluginMethod
    fun logout(call: PluginCall) {
        store.clear()
        call.resolve()
    }

    // ── multi-gateway (M6) ────────────────────────────────────────

    @PluginMethod
    fun listSessions(call: PluginCall) {
        val arr = JSArray()
        for (session in store.list()) arr.put(session.toJs())
        val ret = JSObject()
        ret.put("sessions", arr)
        call.resolve(ret)
    }

    @PluginMethod
    fun switchSession(call: PluginCall) {
        val origin = call.getString("origin") ?: return call.reject("origin required", "failed")
        val basePath = call.getString("basePath") ?: ""
        val session = store.switchTo(origin, basePath)
        val ret = JSObject()
        ret.put("session", session?.toJs() ?: JSONObject.NULL)
        call.resolve(ret)
    }

    @PluginMethod
    fun removeSession(call: PluginCall) {
        val origin = call.getString("origin") ?: return call.reject("origin required", "failed")
        store.remove(origin, call.getString("basePath") ?: "")
        call.resolve()
    }

    // ── login ───────────────────────────────────────────────────────

    @PluginMethod
    fun login(call: PluginCall) {
        val origin = call.getString("origin")?.trimEnd('/')
        if (origin.isNullOrEmpty()) {
            call.reject("origin required", "failed")
            return
        }
        val basePath = call.getString("basePath") ?: ""
        val provider = call.getString("provider") ?: ""
        val mode = call.getString("redirectMode") ?: "loopback"

        pending.getAndSet(null)?.let { previous ->
            previous.listener?.closeQuietly()
            previous.call.reject("Superseded by a new sign-in", "cancelled")
        }

        val verifier = b64url(randomBytes(32))
        val challenge = b64url(sha256(verifier.toByteArray(Charsets.US_ASCII)))
        val state = b64url(randomBytes(24))

        val listener: ServerSocket?
        val redirectUri: String
        if (mode == "scheme") {
            listener = null
            redirectUri = "$APP_SCHEME:$APP_REDIRECT_PATH"
        } else {
            listener = try {
                ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).apply {
                    soTimeout = LOGIN_TIMEOUT_MS
                }
            } catch (e: IOException) {
                call.reject("Could not open a loopback listener: ${e.message}", "failed")
                return
            }
            redirectUri = "http://127.0.0.1:${listener.localPort}/callback"
        }

        val p = Pending(call, origin, basePath, verifier, state, mode, listener)
        pending.set(p)

        val authorize = Uri.parse("$origin$basePath/auth/native/authorize").buildUpon()
            .appendQueryParameter("code_challenge", challenge)
            .appendQueryParameter("code_challenge_method", "S256")
            .appendQueryParameter("redirect_uri", redirectUri)
            .appendQueryParameter("state", state)
            .apply { if (provider.isNotEmpty()) appendQueryParameter("provider", provider) }
            .build()

        if (listener != null) {
            Thread({ awaitLoopback(p, listener) }, "hermes-auth-loopback").apply {
                isDaemon = true
                start()
            }
        }

        activity.runOnUiThread {
            try {
                CustomTabsIntent.Builder().build().launchUrl(activity, authorize)
            } catch (e: Exception) {
                finish(p, error = "No browser available to sign in: ${e.message}", code = "failed")
            }
        }
    }

    /** Loopback listener thread: one request, one answer, done. */
    private fun awaitLoopback(p: Pending, listener: ServerSocket) {
        try {
            listener.use { server ->
                server.accept().use { socket ->
                    val reader = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.US_ASCII))
                    val requestLine = reader.readLine() ?: ""
                    while (true) {
                        val line = reader.readLine() ?: break
                        if (line.isEmpty()) break
                    }
                    val path = requestLine.split(" ").getOrNull(1) ?: ""
                    val ok = handleCallback(p, Uri.parse("http://127.0.0.1$path"))
                    val body = if (ok) CLOSE_PAGE_OK else CLOSE_PAGE_ERR
                    val bytes = body.toByteArray(Charsets.UTF_8)
                    socket.getOutputStream().apply {
                        write(
                            ("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n" +
                                "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n").toByteArray(Charsets.US_ASCII)
                        )
                        write(bytes)
                        flush()
                    }
                }
            }
        } catch (e: SocketTimeoutException) {
            finish(p, error = "Sign-in timed out", code = "cancelled")
        } catch (e: IOException) {
            if (pending.get() === p) finish(p, error = "Loopback listener failed: ${e.message}", code = "failed")
        }
    }

    /** Scheme redirect: the browser handed the code to our intent filter. */
    override fun handleOnNewIntent(intent: Intent) {
        val data = intent.data ?: return
        if (data.scheme != APP_SCHEME) return
        val p = pending.get() ?: return
        if (p.mode != "scheme") return
        if (data.path != APP_REDIRECT_PATH) {
            finish(p, error = "Unexpected redirect path", code = "failed")
            return
        }
        handleCallback(p, data)
    }

    /**
     * The Custom Tab closing resumes us. If it closed without delivering a
     * code (user backed out), fail the pending login after a short grace so
     * a redirect that is still landing on the loopback listener wins.
     */
    override fun handleOnResume() {
        val p = pending.get() ?: return
        Thread {
            Thread.sleep(RESUME_GRACE_MS)
            if (pending.get() === p && p.codeReceived.get() == null) {
                finish(p, error = "Sign-in was cancelled", code = "cancelled")
            }
        }.start()
    }

    /** Verify state, mark the code received, exchange it. Returns whether the redirect was accepted. */
    private fun handleCallback(p: Pending, uri: Uri): Boolean {
        val error = uri.getQueryParameter("error")
        if (error != null) {
            val desc = uri.getQueryParameter("error_description") ?: ""
            finish(p, error = "Gateway rejected sign-in: $error ${desc}".trim(), code = "failed")
            return false
        }
        val code = uri.getQueryParameter("code") ?: ""
        val state = uri.getQueryParameter("state") ?: ""
        if (code.isEmpty() || !constantTimeEquals(state, p.state)) {
            // Never redeem a code that arrived with a mismatched state (RFC 6749 §10.12).
            finish(p, error = "Sign-in callback state mismatch", code = "failed")
            return false
        }
        if (!p.codeReceived.compareAndSet(null, code)) return true // duplicate delivery
        exchangeCode(p, code)
        return true
    }

    private fun exchangeCode(p: Pending, code: String) {
        val body = JSONObject().put("code", code).put("code_verifier", p.verifier).toString()
        val req = Request.Builder()
            .url("${p.origin}${p.basePath}/auth/native/token")
            .post(body.toRequestBody(JSON))
            .build()
        Thread {
            try {
                HermesTransport.client.newCall(req).execute().use { res ->
                    val text = res.body?.string() ?: ""
                    if (res.code != 200) {
                        finish(p, error = "Token exchange failed (HTTP ${res.code})", code = "failed")
                        return@use
                    }
                    val session = parseTokens(JSONObject(text), p.origin, p.basePath)
                    store.save(session)
                    finish(p, session = session)
                }
            } catch (e: Exception) {
                finish(p, error = "Token exchange failed: ${e.message}", code = "unavailable")
            }
        }.start()
    }

    private fun finish(p: Pending, session: HermesTokenStore.Session? = null, error: String? = null, code: String = "failed") {
        if (!pending.compareAndSet(p, null)) return
        p.listener?.closeQuietly()
        if (session != null) {
            val ret = JSObject()
            ret.put("session", session.toJs())
            p.call.resolve(ret)
        } else {
            p.call.reject(error ?: "Sign-in failed", code)
        }
    }

    // ── refresh ─────────────────────────────────────────────────────

    @PluginMethod
    fun refresh(call: PluginCall) {
        val current = store.load()
        if (current == null || current.refreshToken.isEmpty()) {
            call.reject("No refreshable session", "session_expired")
            return
        }
        val body = JSONObject()
            .put("refresh_token", current.refreshToken)
            .put("provider", current.provider)
            .toString()
        val req = Request.Builder()
            .url("${current.origin}${current.basePath}/auth/native/refresh")
            .post(body.toRequestBody(JSON))
            .build()
        Thread {
            try {
                HermesTransport.client.newCall(req).execute().use { res ->
                    val text = res.body?.string() ?: ""
                    when (res.code) {
                        200 -> {
                            val session = parseTokens(JSONObject(text), current.origin, current.basePath)
                            store.save(session)
                            val ret = JSObject()
                            ret.put("session", session.toJs())
                            call.resolve(ret)
                        }
                        401 -> {
                            // The gateway's terminal answer: every provider rejected the RT.
                            store.clear()
                            call.reject("Session expired; sign in again", "session_expired")
                        }
                        else -> call.reject("Gateway could not refresh (HTTP ${res.code})", "unavailable")
                    }
                }
            } catch (e: Exception) {
                call.reject("Gateway unreachable: ${e.message}", "unavailable")
            }
        }.start()
    }

    // ── helpers ─────────────────────────────────────────────────────

    private fun parseTokens(json: JSONObject, origin: String, basePath: String): HermesTokenStore.Session {
        val access = json.optString("access_token", "")
        if (access.isEmpty()) throw IllegalStateException("token response missing access_token")
        return HermesTokenStore.Session(
            origin = origin,
            basePath = basePath,
            accessToken = access,
            refreshToken = json.optString("refresh_token", ""),
            expiresAt = json.optLong("expires_at", 0L),
            userId = json.optString("user_id", ""),
            provider = json.optString("provider", ""),
        )
    }

    private fun randomBytes(n: Int): ByteArray = ByteArray(n).also { SecureRandom().nextBytes(it) }
    private fun sha256(input: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(input)
    private fun b64url(bytes: ByteArray): String =
        Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    private fun constantTimeEquals(a: String, b: String): Boolean =
        MessageDigest.isEqual(a.toByteArray(Charsets.UTF_8), b.toByteArray(Charsets.UTF_8))

    private fun ServerSocket.closeQuietly() = try { close() } catch (_: IOException) {}

    private companion object {
        const val APP_SCHEME = "com.nousresearch.hermes"
        const val APP_REDIRECT_PATH = "/oauth2redirect"
        const val LOGIN_TIMEOUT_MS = 5 * 60 * 1000
        const val RESUME_GRACE_MS = 2500L
        val JSON = "application/json; charset=utf-8".toMediaType()
        const val CLOSE_PAGE_OK =
            "<!doctype html><meta name=viewport content='width=device-width'>" +
                "<body style='font-family:sans-serif;padding:2rem'><h2>Signed in to Hermes</h2>" +
                "<p>You can close this window and return to the app.</p></body>"
        const val CLOSE_PAGE_ERR =
            "<!doctype html><meta name=viewport content='width=device-width'>" +
                "<body style='font-family:sans-serif;padding:2rem'><h2>Sign-in failed</h2>" +
                "<p>Return to the app and try again.</p></body>"
    }
}
