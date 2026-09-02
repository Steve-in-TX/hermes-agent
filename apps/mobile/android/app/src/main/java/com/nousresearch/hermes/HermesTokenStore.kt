package com.nousresearch.hermes

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.getcapacitor.JSObject
import org.json.JSONObject

/**
 * Signed-in gateway sessions, at rest in EncryptedSharedPreferences
 * (AES-256-GCM values, AES-256-SIV keys, master key in the Android Keystore).
 * Never `localStorage`, never plain prefs.
 *
 * M6: one session per gateway, keyed by `origin + basePath`, plus a pointer
 * to the active one — so the app can hold several gateways and switch. The
 * refresh token never leaves this process: JS only ever receives the access
 * token (see [Session.toJs]).
 */
class HermesTokenStore(context: Context) {
    data class Session(
        val origin: String,
        val basePath: String,
        val accessToken: String,
        val refreshToken: String,
        val expiresAt: Long,
        val userId: String,
        val provider: String,
    ) {
        val key: String get() = keyFor(origin, basePath)

        /** What the WebView is allowed to see — no refresh token. */
        fun toJs(): JSObject = JSObject().apply {
            put("origin", origin)
            put("basePath", basePath)
            put("accessToken", accessToken)
            put("expiresAt", expiresAt)
            put("userId", userId)
            put("provider", provider)
        }

        fun toJson(): JSONObject = JSONObject().apply {
            put("origin", origin)
            put("basePath", basePath)
            put("accessToken", accessToken)
            put("refreshToken", refreshToken)
            put("expiresAt", expiresAt)
            put("userId", userId)
            put("provider", provider)
        }

        companion object {
            fun fromJson(json: JSONObject): Session? {
                val origin = json.optString("origin", "")
                val access = json.optString("accessToken", "")
                if (origin.isEmpty() || access.isEmpty()) return null
                return Session(
                    origin = origin,
                    basePath = json.optString("basePath", ""),
                    accessToken = access,
                    refreshToken = json.optString("refreshToken", ""),
                    expiresAt = json.optLong("expiresAt", 0L),
                    userId = json.optString("userId", ""),
                    provider = json.optString("provider", ""),
                )
            }
        }
    }

    private val prefs: SharedPreferences by lazy {
        val masterKey = MasterKey.Builder(context.applicationContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context.applicationContext,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    private fun readAll(): MutableMap<String, Session> {
        val out = LinkedHashMap<String, Session>()
        val raw = prefs.getString(KEY_SESSIONS, null) ?: return migrateLegacy(out)
        val json = runCatching { JSONObject(raw) }.getOrNull() ?: return out
        for (key in json.keys()) {
            Session.fromJson(json.optJSONObject(key) ?: continue)?.let { out[key] = it }
        }
        return out
    }

    /** M2 stored a single flat session; fold it into the map once. */
    private fun migrateLegacy(out: MutableMap<String, Session>): MutableMap<String, Session> {
        val origin = prefs.getString(LEGACY_ORIGIN, null) ?: return out
        val access = prefs.getString(LEGACY_ACCESS, null) ?: return out
        if (origin.isEmpty() || access.isEmpty()) return out
        val session = Session(
            origin = origin,
            basePath = prefs.getString(LEGACY_BASE_PATH, "") ?: "",
            accessToken = access,
            refreshToken = prefs.getString(LEGACY_REFRESH, "") ?: "",
            expiresAt = prefs.getLong(LEGACY_EXPIRES_AT, 0L),
            userId = prefs.getString(LEGACY_USER_ID, "") ?: "",
            provider = prefs.getString(LEGACY_PROVIDER, "") ?: "",
        )
        out[session.key] = session
        writeAll(out, session.key)
        prefs.edit()
            .remove(LEGACY_ORIGIN).remove(LEGACY_BASE_PATH).remove(LEGACY_ACCESS)
            .remove(LEGACY_REFRESH).remove(LEGACY_EXPIRES_AT).remove(LEGACY_USER_ID).remove(LEGACY_PROVIDER)
            .apply()
        return out
    }

    private fun writeAll(sessions: Map<String, Session>, active: String?) {
        val json = JSONObject()
        for ((key, session) in sessions) json.put(key, session.toJson())
        prefs.edit()
            .putString(KEY_SESSIONS, json.toString())
            .putString(KEY_ACTIVE, active)
            .apply()
    }

    /** The active session, if any. */
    @Synchronized
    fun load(): Session? {
        val all = readAll()
        val active = prefs.getString(KEY_ACTIVE, null) ?: return null
        return all[active]
    }

    @Synchronized
    fun list(): List<Session> = readAll().values.toList()

    /** Store (or replace) a gateway's session and make it active. */
    @Synchronized
    fun save(session: Session) {
        val all = readAll()
        all[session.key] = session
        writeAll(all, session.key)
    }

    /** Make an already-stored gateway active; null when unknown. */
    @Synchronized
    fun switchTo(origin: String, basePath: String): Session? {
        val all = readAll()
        val session = all[keyFor(origin, basePath)] ?: return null
        writeAll(all, session.key)
        return session
    }

    /** Forget one gateway; clears the active pointer if it was that one. */
    @Synchronized
    fun remove(origin: String, basePath: String) {
        val all = readAll()
        val key = keyFor(origin, basePath)
        all.remove(key)
        val active = prefs.getString(KEY_ACTIVE, null)
        writeAll(all, if (active == key) null else active)
    }

    /** Sign out of the active gateway (its stored session is dropped). */
    @Synchronized
    fun clear() {
        val active = prefs.getString(KEY_ACTIVE, null) ?: return
        val all = readAll()
        all.remove(active)
        writeAll(all, null)
    }

    companion object {
        private const val PREFS_NAME = "hermes_auth"
        private const val KEY_SESSIONS = "sessions"
        private const val KEY_ACTIVE = "active"
        private const val LEGACY_ORIGIN = "origin"
        private const val LEGACY_BASE_PATH = "basePath"
        private const val LEGACY_ACCESS = "accessToken"
        private const val LEGACY_REFRESH = "refreshToken"
        private const val LEGACY_EXPIRES_AT = "expiresAt"
        private const val LEGACY_USER_ID = "userId"
        private const val LEGACY_PROVIDER = "provider"

        fun keyFor(origin: String, basePath: String): String {
            val o = origin.trimEnd('/')
            val b = basePath.trim().let { if (it.isEmpty()) "" else (if (it.startsWith("/")) it else "/$it").trimEnd('/') }
            return "$o$b"
        }
    }
}
