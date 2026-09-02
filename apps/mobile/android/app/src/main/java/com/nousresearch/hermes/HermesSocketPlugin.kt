package com.nousresearch.hermes

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.decodeBase64

/**
 * `HermesSocket` — native WebSockets for the dashboard bundle.
 *
 * `connect` resolves with an id *before* dialling so the JS side has
 * registered the id by the time `open`/`message`/`close`/`error` events arrive
 * (events carry the id; the JS registry routes them). Subprotocols are sent
 * verbatim in `Sec-WebSocket-Protocol` — that is how the gateway ticket
 * travels for `/api/ws`. OkHttp sends no `Origin` header, which is what the
 * gateway's WS guard needs on a specific-address bind.
 */
@CapacitorPlugin(name = "HermesSocket")
class HermesSocketPlugin : Plugin() {
    private val sockets = ConcurrentHashMap<String, WebSocket>()
    private val counter = AtomicInteger()

    @PluginMethod
    fun connect(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrEmpty()) {
            call.reject("url required")
            return
        }
        val protocols = call.getArray("protocols")?.toList<String>() ?: emptyList()
        val id = "ws${counter.incrementAndGet()}"

        val builder = try {
            Request.Builder().url(url)
        } catch (e: IllegalArgumentException) {
            call.reject("invalid url: ${e.message}", "failed")
            return
        }
        if (protocols.isNotEmpty()) {
            builder.header("Sec-WebSocket-Protocol", protocols.joinToString(", "))
        }

        val ret = JSObject()
        ret.put("id", id)
        call.resolve(ret)

        val socket = HermesTransport.client.newWebSocket(builder.build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                emit("open", id) { put("protocol", response.header("Sec-WebSocket-Protocol") ?: "") }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                emit("message", id) { put("data", text) }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                emit("message", id) { put("dataBase64", bytes.base64()) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                sockets.remove(id)
                emit("close", id) {
                    put("code", code)
                    put("reason", reason)
                    put("wasClean", true)
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                sockets.remove(id)
                emit("error", id) {
                    put("message", t.message ?: t.javaClass.simpleName)
                    response?.let { put("status", it.code) }
                }
                emit("close", id) {
                    put("code", 1006)
                    put("reason", t.message ?: "")
                    put("wasClean", false)
                }
            }
        })
        sockets[id] = socket
    }

    @PluginMethod
    fun send(call: PluginCall) {
        val socket = sockets[call.getString("id") ?: ""]
        if (socket == null) {
            call.reject("no such socket")
            return
        }
        val text = call.getString("data")
        val base64 = call.getString("dataBase64")
        val ok = when {
            base64 != null -> base64.decodeBase64()?.let { socket.send(it) } ?: false
            text != null -> socket.send(text)
            else -> false
        }
        if (ok) call.resolve() else call.reject("send failed")
    }

    @PluginMethod
    fun close(call: PluginCall) {
        val id = call.getString("id") ?: ""
        val socket = sockets.remove(id)
        socket?.close(call.getInt("code") ?: 1000, call.getString("reason"))
        call.resolve()
    }

    private fun emit(event: String, id: String, fill: JSObject.() -> Unit) {
        val data = JSObject()
        data.put("id", id)
        data.fill()
        // retainUntilConsumed=true: never drop a frame that beats the JS
        // listener registration on a cold start.
        notifyListeners(event, data, true)
    }
}
