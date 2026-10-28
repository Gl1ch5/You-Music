package app.youmusic.ai

import app.youmusic.bridge.BridgeException
import app.youmusic.bridge.BridgeJson
import app.youmusic.data.KeyValueStore
import app.youmusic.net.Http
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

@Serializable
data class AiConfigDto(val baseUrl: String = "", val model: String = "", val enabled: Boolean = false, val hasKey: Boolean = false)

@Serializable
private data class StoredAi(val baseUrl: String = "", val model: String = "", val key: String = "", val enabled: Boolean = false)

@Serializable
data class AiMessage(val role: String, val content: String)

/**
 * Minimal OpenAI-compatible chat client for "neuro" recommendations. Prompts and parsing live in the UI
 * (web/src/logic/ai.ts); the key never leaves native storage.
 */
class AiClient(private val kv: KeyValueStore) {
    private var stored: StoredAi = load()

    private fun load() = kv.get(KEY)?.let { runCatching { BridgeJson.decodeFromString(StoredAi.serializer(), it) }.getOrNull() } ?: StoredAi()

    /** Saved settings without the API key: the key never leaves the device. */
    fun backup(): String = BridgeJson.encodeToString(StoredAi.serializer(), stored.copy(key = ""))

    /** Restores [backup] output, keeping the key already on this device. */
    fun restore(raw: String) {
        val restored = runCatching { BridgeJson.decodeFromString(StoredAi.serializer(), raw) }.getOrNull() ?: return
        stored = restored.copy(key = stored.key)
        kv.set(KEY, BridgeJson.encodeToString(StoredAi.serializer(), stored))
    }

    fun config() = AiConfigDto(stored.baseUrl, stored.model, stored.enabled, stored.key.isNotEmpty())

    fun configure(baseUrl: String?, model: String?, key: String?, enabled: Boolean?): AiConfigDto {
        stored = stored.copy(
            baseUrl = baseUrl?.trim()?.trimEnd('/') ?: stored.baseUrl,
            model = model?.trim() ?: stored.model,
            key = key?.trim() ?: stored.key,
            enabled = enabled ?: stored.enabled,
        )
        kv.set(KEY, BridgeJson.encodeToString(StoredAi.serializer(), stored))
        return config()
    }

    fun chat(messages: List<AiMessage>, temperature: Double): String {
        if (stored.baseUrl.isEmpty() || stored.model.isEmpty()) throw BridgeException("ai_not_configured", "Нейро-рекомендации не настроены")
        val body = BridgeJson.encodeToString(ChatRequest.serializer(), ChatRequest(stored.model, messages, temperature))
        val request = Request.Builder()
            .url("${stored.baseUrl}/chat/completions")
            .post(body.toRequestBody("application/json".toMediaType()))
            .apply { if (stored.key.isNotEmpty()) header("Authorization", "Bearer ${stored.key}") }
            .build()
        val client = Http.client.newBuilder().readTimeout(90, TimeUnit.SECONDS).build()
        client.newCall(request).execute().use { r ->
            val text = r.body.string()
            if (!r.isSuccessful) throw BridgeException("ai_error", "Нейросеть ответила ${r.code}: ${text.take(200)}")
            val choice = (BridgeJson.parseToJsonElement(text).jsonObject["choices"] as? JsonArray)?.firstOrNull() as? JsonObject
            return (choice?.get("message") as? JsonObject)?.get("content")?.jsonPrimitive?.contentOrNull
                ?: throw BridgeException("ai_error", "Пустой ответ нейросети")
        }
    }

    @Serializable
    private data class ChatRequest(val model: String, val messages: List<AiMessage>, val temperature: Double)

    companion object {
        const val KEY = "native.ai"
    }
}
