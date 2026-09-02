package com.nousresearch.hermes

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.getcapacitor.JSObject

/**
 * The app's one signed-in gateway session, at rest in
 * EncryptedSharedPreferences (AES-256-GCM values, AES-256-SIV keys, master
 * key in the Android Keystore). Never `localStorage`, never plain prefs.
 *
 * The refresh token never leaves this process: JS only ever receives the
 * access token (see HermesAuthPlugin.sessionForJs).
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
        /** What the WebView is allowed to see — no refresh token. */
        fun toJs(): JSObject = JSObject().apply {
            put("origin", origin)
            put("basePath", basePath)
            put("accessToken", accessToken)
            put("expiresAt", expiresAt)
            put("userId", userId)
            put("provider", provider)
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

    @Synchronized
    fun load(): Session? {
        val origin = prefs.getString(KEY_ORIGIN, null) ?: return null
        val access = prefs.getString(KEY_ACCESS, null) ?: return null
        if (origin.isEmpty() || access.isEmpty()) return null
        return Session(
            origin = origin,
            basePath = prefs.getString(KEY_BASE_PATH, "") ?: "",
            accessToken = access,
            refreshToken = prefs.getString(KEY_REFRESH, "") ?: "",
            expiresAt = prefs.getLong(KEY_EXPIRES_AT, 0L),
            userId = prefs.getString(KEY_USER_ID, "") ?: "",
            provider = prefs.getString(KEY_PROVIDER, "") ?: "",
        )
    }

    @Synchronized
    fun save(session: Session) {
        prefs.edit()
            .putString(KEY_ORIGIN, session.origin)
            .putString(KEY_BASE_PATH, session.basePath)
            .putString(KEY_ACCESS, session.accessToken)
            .putString(KEY_REFRESH, session.refreshToken)
            .putLong(KEY_EXPIRES_AT, session.expiresAt)
            .putString(KEY_USER_ID, session.userId)
            .putString(KEY_PROVIDER, session.provider)
            .apply()
    }

    @Synchronized
    fun clear() {
        prefs.edit().clear().apply()
    }

    private companion object {
        const val PREFS_NAME = "hermes_auth"
        const val KEY_ORIGIN = "origin"
        const val KEY_BASE_PATH = "basePath"
        const val KEY_ACCESS = "accessToken"
        const val KEY_REFRESH = "refreshToken"
        const val KEY_EXPIRES_AT = "expiresAt"
        const val KEY_USER_ID = "userId"
        const val KEY_PROVIDER = "provider"
    }
}
