package app.youmusic.source

import android.util.LruCache
import app.youmusic.bridge.BridgeJson
import app.youmusic.net.Http
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.FormBody
import okhttp3.Request

@Serializable
data class TranslationDto(val lines: List<String>, val from: String? = null)

/**
 * Lyrics translation through the public Google Translate web endpoint (no key). Line breaks are kept, so the
 * translation lines up with the original, synced lines included.
 */
class Translator {
    private val cache = LruCache<String, TranslationDto>(32)

    fun translate(lines: List<String>, to: String): TranslationDto {
        val text = lines.joinToString("\n")
        val key = "$to|${text.hashCode()}"
        cache.get(key)?.let { return it }
        val body = FormBody.Builder().add("q", text).build()
        val url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=$to&dt=t"
        val json = Http.client.newCall(Request.Builder().url(url).post(body).header("User-Agent", Http.DESKTOP_UA).build()).execute().use { r ->
            if (!r.isSuccessful) throw java.io.IOException("HTTP ${r.code}")
            BridgeJson.parseToJsonElement(r.body.string()) as JsonArray
        }
        val joined = (json[0] as? JsonArray).orEmpty()
            .joinToString("") { ((it as? JsonArray)?.getOrNull(0) as? JsonPrimitive)?.contentOrNull.orEmpty() }
        val from = (json.getOrNull(2) as? JsonPrimitive)?.contentOrNull
        val out = joined.split("\n").map { it.trim() }
        // Keep one translated line per original line, even if the service merged or split some.
        val aligned = lines.indices.map { i -> if (lines[i].isBlank()) "" else out.getOrNull(i).orEmpty() }
        return TranslationDto(aligned, from).also { cache.put(key, it) }
    }
}
