package com.nousresearch.hermes

import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient

/**
 * One OkHttp client for the whole app — REST and WebSockets share its
 * connection pool and thread pool.
 *
 * Nothing here adds an `Origin` header: that is the whole point. The gateway's
 * WebSocket guard allows a missing Origin (the packaged-Electron path), and a
 * native HTTP client is outside CORS entirely. See apps/mobile/spikes/m0.
 */
object HermesTransport {
    val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            // Streaming endpoints hold the socket open; ping keeps NAT/idle
            // timers happy and detects a dead radio without waiting for TCP.
            .pingInterval(20, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }
}
