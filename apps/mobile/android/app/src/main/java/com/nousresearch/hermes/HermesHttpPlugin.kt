package com.nousresearch.hermes

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.IOException
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.internal.http.HttpMethod

/**
 * `HermesHttp.request` — the native side of `web/src/lib/transport/capacitor.ts`.
 *
 * Takes a fetch-shaped request (url, method, headers, text or base64 body),
 * performs it with OkHttp, and returns status + headers + base64 body so the
 * JS side can rebuild a real `Response`. Bearer auth is just a header the
 * caller sets; nothing here knows about tokens.
 */
@CapacitorPlugin(name = "HermesHttp")
class HermesHttpPlugin : Plugin() {

    @PluginMethod
    fun request(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrEmpty()) {
            call.reject("url required")
            return
        }
        val method = (call.getString("method") ?: "GET").uppercase()
        val headers = call.getObject("headers") ?: JSObject()
        val textBody = call.getString("body")
        val base64Body = call.getString("bodyBase64")

        val builder = Request.Builder().url(url)
        var contentType: String? = null
        val keys = headers.keys()
        while (keys.hasNext()) {
            val name = keys.next()
            val value = headers.getString(name) ?: continue
            if (name.equals("content-type", ignoreCase = true)) contentType = value
            builder.header(name, value)
        }

        val mediaType = contentType?.toMediaTypeOrNull()
        val body: RequestBody? = when {
            base64Body != null -> Base64.decode(base64Body, Base64.DEFAULT).toRequestBody(mediaType)
            textBody != null -> textBody.toRequestBody(mediaType)
            HttpMethod.requiresRequestBody(method) -> ByteArray(0).toRequestBody(null)
            else -> null
        }
        builder.method(method, body)

        HermesTransport.client.newCall(builder.build()).enqueue(object : Callback {
            override fun onFailure(okCall: Call, e: IOException) {
                call.reject("network: ${e.message ?: e.javaClass.simpleName}", e)
            }

            override fun onResponse(okCall: Call, response: Response) {
                response.use { res ->
                    val result = JSObject()
                    result.put("status", res.code)
                    result.put("statusText", res.message)
                    val outHeaders = JSObject()
                    for (name in res.headers.names()) {
                        outHeaders.put(name.lowercase(), res.headers.values(name).joinToString(", "))
                    }
                    result.put("headers", outHeaders)
                    val bytes = res.body?.bytes() ?: ByteArray(0)
                    result.put("bodyBase64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                    result.put("url", res.request.url.toString())
                    call.resolve(result)
                }
            }
        })
    }
}
