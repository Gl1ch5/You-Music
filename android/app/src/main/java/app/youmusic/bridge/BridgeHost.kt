package app.youmusic.bridge

import android.net.Uri
import android.util.Log
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import app.youmusic.source.toBridgeException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Receives `{id, cmd, args}` messages from the page and replies with `{type:"res", id, ok, result|error}`.
 * Events go out as `{type:"event", name, data}`. Only pages served from [ORIGIN] can reach this object.
 */
class BridgeHost(
    private val scope: CoroutineScope,
    private val registry: CommandRegistry,
) : WebViewCompat.WebMessageListener {

    private var reply: JavaScriptReplyProxy? = null

    override fun onPostMessage(
        view: WebView,
        message: WebMessageCompat,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy,
    ) {
        if (!isMainFrame || sourceOrigin.toString().trimEnd('/') != ORIGIN) return
        reply = replyProxy
        val text = message.data ?: return
        scope.launch { send(handle(text)) }
    }

    private suspend fun handle(text: String): String {
        var id = -1
        return try {
            val msg = BridgeJson.parseToJsonElement(text).jsonObject
            id = msg["id"]?.jsonPrimitive?.int ?: -1
            val cmd = msg["cmd"]?.jsonPrimitive?.contentOrNull ?: throw BridgeException("bad_request", "Missing cmd")
            val handler = registry.find(cmd) ?: throw BridgeException("unknown_command", "Unknown command: $cmd")
            val args = msg["args"]?.takeIf { it !is JsonNull } ?: CommandRegistry.EMPTY_ARGS
            val result = withContext(Dispatchers.IO) { handler(args) }
            response(id, result, null)
        } catch (t: Throwable) {
            val e = t.toBridgeException()
            if (e.code != "cancelled") Log.w(TAG, "Command failed: ${e.code} ${e.message}", t)
            response(id, null, e)
        }
    }

    private fun response(id: Int, result: JsonElement?, error: BridgeException?): String = buildJsonObject {
        put("type", "res")
        put("id", id)
        put("ok", error == null)
        if (error == null) put("result", result ?: JsonNull)
        else put("error", buildJsonObject {
            put("code", error.code)
            put("message", JsonPrimitive(error.message ?: error.code))
        })
    }.toString()

    fun emit(event: BridgeEvent) {
        send(buildJsonObject {
            put("type", "event")
            put("name", event.name)
            put("data", event.data)
        }.toString())
    }

    private fun send(text: String) {
        scope.launch(Dispatchers.Main) { reply?.postMessage(text) }
    }

    companion object {
        const val ORIGIN = "https://appassets.androidplatform.net"
        const val OBJECT_NAME = "youBridge"
        private const val TAG = "Bridge"
    }
}
