package app.youmusic.cloud

import android.content.Context
import androidx.core.content.edit
import app.youmusic.ai.AiFallback
import app.youmusic.ai.AiMessage
import app.youmusic.bridge.BridgeException
import app.youmusic.bridge.BridgeJson
import app.youmusic.bridge.EventBus
import app.youmusic.data.BackupManager
import app.youmusic.net.Http
import app.youmusic.net.NetworkMonitor
import app.youmusic.net.ProxyDto
import app.youmusic.net.ProxyManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

@Serializable
data class ServerAiDto(val enabled: Boolean = false, val limit: Int = 0, val left: Int = 0)

@Serializable
data class ServerProxyDto(val type: String = "http", val host: String = "", val port: Int = 0, val user: String = "", val pass: String = "")

@Serializable
data class ServerUserDto(
    val login: String,
    val createdAt: Long = 0,
    val syncedAt: Long = 0,
    val ai: ServerAiDto = ServerAiDto(),
    val proxy: ServerProxyDto? = null,
)

@Serializable
data class ServerStatusDto(
    val signedIn: Boolean,
    val login: String? = null,
    /** Last successful sync on this device. */
    val syncedAt: Long = 0,
    val syncing: Boolean = false,
    val syncError: String? = null,
    val ai: ServerAiDto = ServerAiDto(),
    val proxyAvailable: Boolean = false,
    val proxyOn: Boolean = false,
)

@Serializable
private data class AuthResponse(val token: String, val user: ServerUserDto)

@Serializable
private data class SyncResponse(val updatedAt: Long = 0, val data: String? = null)

@Serializable
private data class SyncUpload(val data: String)

@Serializable
private data class Credentials(val login: String, val password: String)

@Serializable
data class TgLinkDto(val code: String, val url: String, val linked: Boolean = false)

@Serializable
data class TgTrackDto(
    val id: String,
    val title: String,
    val artist: String = "",
    val durationMs: Long = 0,
    val size: Long = 0,
    val mime: String = "audio/mpeg",
    /** Absolute URL (public by its random id) or null. */
    val cover: String? = null,
    val at: Long = 0,
)

@Serializable
data class TgListDto(val linked: Boolean = false, val bot: String = "", val tracks: List<TgTrackDto> = emptyList())

@Serializable
private data class ChatBody(val messages: List<AiMessage>, val temperature: Double, val tier: String = "fast")

/**
 * Optional You Music account on the author's server: cloud sync of the library, AI recommendations
 * with a daily limit and a free proxy. The token and proxy credentials live in their own preferences,
 * never in the kv store, so they do not end up in backups.
 */
class ServerClient(
    context: Context,
    private val backup: BackupManager,
    private val proxies: ProxyManager,
    private val network: NetworkMonitor,
    private val scope: CoroutineScope,
) : AiFallback {
    private val prefs = context.getSharedPreferences("server", Context.MODE_PRIVATE)
    private val syncLock = Mutex()
    private var pendingPush: Job? = null
    @Volatile private var syncing = false
    @Volatile private var syncError: String? = null

    private var token: String?
        get() = prefs.getString(TOKEN, null)
        set(v) = prefs.edit { if (v == null) remove(TOKEN) else putString(TOKEN, v) }

    private var user: ServerUserDto?
        get() = prefs.getString(USER, null)?.let { runCatching { BridgeJson.decodeFromString(ServerUserDto.serializer(), it) }.getOrNull() }
        set(v) = prefs.edit { if (v == null) remove(USER) else putString(USER, BridgeJson.encodeToString(ServerUserDto.serializer(), v)) }

    val signedIn: Boolean get() = token != null

    init {
        user?.proxy?.let { proxies.setServerProxy(it.toProxy()) }
        backup.onDataChanged = { schedulePush() }
        network.onChange { old, new -> if (!old.online && new.online && signedIn) scope.launch { runCatching { sync() } } }
    }

    fun status(): ServerStatusDto {
        val u = user
        return ServerStatusDto(
            signedIn = signedIn,
            login = u?.login,
            syncedAt = prefs.getLong(SYNCED_AT, 0),
            syncing = syncing,
            syncError = syncError,
            ai = u?.ai ?: ServerAiDto(),
            proxyAvailable = u?.proxy != null,
            proxyOn = proxies.state().let { it.inUse && it.activeId == ProxyManager.SERVER_ID },
        )
    }

    /** Signs in (or registers), then merges the cloud library with this device's. */
    suspend fun auth(login: String, password: String, register: Boolean): ServerStatusDto {
        val body = BridgeJson.encodeToString(Credentials.serializer(), Credentials(login.trim(), password))
        val res = request(if (register) "/api/register" else "/api/login", "POST", body, AuthResponse.serializer(), auth = false)
        token = res.token
        saveUser(res.user)
        prefs.edit { putLong(SYNCED_AT, 0); putLong(REMOTE_AT, 0) }
        runCatching { sync() }
        return status()
    }

    suspend fun logout(): ServerStatusDto {
        runCatching { request("/api/logout", "POST", "{}", JsonObject.serializer()) }
        token = null
        saveUser(null)
        prefs.edit { remove(SYNCED_AT); remove(REMOTE_AT) }
        syncError = null
        emit()
        return status()
    }

    /** Refreshes the account (AI quota left, proxy credentials). */
    suspend fun refresh(): ServerStatusDto {
        if (!signedIn) return status()
        runCatching { saveUser(request("/api/me", "GET", null, ServerUserDto.serializer())) }
            .onFailure { if (it is BridgeException && it.code == "unauthorized") logout() }
        return status()
    }

    /**
     * Pulls the cloud copy when another device changed it since our last sync (merging, never deleting),
     * then pushes this device's full library.
     */
    suspend fun sync(): ServerStatusDto {
        if (!signedIn) return status()
        syncLock.withLock { syncLocked() }
        return status()
    }

    private suspend fun syncLocked() {
        syncing = true
        emit()
        try {
            val remote = request("/api/sync", "GET", null, SyncResponse.serializer())
            if (remote.data != null && remote.updatedAt > prefs.getLong(REMOTE_AT, 0)) {
                backup.import(remote.data, merge = true, silent = true)
            }
            val pushed = request("/api/sync", "PUT", BridgeJson.encodeToString(SyncUpload.serializer(), SyncUpload(backup.export())), SyncResponse.serializer())
            prefs.edit { putLong(REMOTE_AT, pushed.updatedAt); putLong(SYNCED_AT, System.currentTimeMillis()) }
            syncError = null
        } catch (e: Exception) {
            syncError = e.message ?: "Не удалось синхронизировать"
            if (e is BridgeException && e.code == "unauthorized") logout()
        } finally {
            syncing = false
            emit()
        }
    }

    fun setProxy(on: Boolean): ServerStatusDto {
        if (on) {
            user?.proxy ?: throw BridgeException("bad_request", "Войдите в аккаунт, чтобы включить бесплатный прокси")
            proxies.select(ProxyManager.SERVER_ID)
        } else if (proxies.state().activeId == ProxyManager.SERVER_ID) {
            proxies.setEnabled(false)
        }
        return status()
    }

    /** AI chat through the server's model (the daily limit is enforced there). */
    override fun chat(messages: List<AiMessage>, temperature: Double, tier: String): String {
        val text = requestBlocking("/api/ai/chat", "POST", BridgeJson.encodeToString(ChatBody.serializer(), ChatBody(messages, temperature, tier)), timeoutSec = 100)
        val obj = BridgeJson.parseToJsonElement(text).jsonObject
        obj["left"]?.jsonPrimitive?.contentOrNull?.toIntOrNull()?.let { left ->
            user?.let { saveUser(it.copy(ai = it.ai.copy(left = left))) }
        }
        return obj["content"]?.jsonPrimitive?.contentOrNull ?: throw BridgeException("ai_error", "Пустой ответ нейросети")
    }

    /** One-time link that binds the user's Telegram chat with the bot to this account. */
    fun tgLink(): TgLinkDto = request("/api/tg/link", "POST", "{}", TgLinkDto.serializer())

    /** Audio files the user sent to the bot, waiting to be imported. */
    fun tgTracks(): TgListDto {
        if (!signedIn) throw BridgeException("unauthorized", "Войдите в аккаунт, чтобы переносить музыку из Telegram")
        val list = request("/api/tg/tracks", "GET", null, TgListDto.serializer())
        return list.copy(tracks = list.tracks.map { t -> t.copy(cover = t.cover?.let { if (it.startsWith("/")) BASE_URL + it else it }) })
    }

    fun tgDelete(id: String) {
        requestBlocking("/api/tg/tracks/$id", "DELETE", null)
    }

    /** Streams a server file into [dest] (written to a temp file first, so a broken download leaves nothing behind). */
    fun download(path: String, dest: java.io.File) {
        if (!network.online) throw BridgeException("offline", "Нет сети")
        val request = Request.Builder().url(BASE_URL + path).apply { token?.let { header("Authorization", "Bearer $it") } }.build()
        val client = Http.client.newBuilder().readTimeout(120, TimeUnit.SECONDS).build()
        val tmp = java.io.File(dest.parentFile, dest.name + ".part")
        try {
            client.newCall(request).execute().use { r ->
                if (!r.isSuccessful) throw BridgeException("server", "Сервер не отдал файл (код ${r.code})")
                tmp.outputStream().use { out -> r.body.byteStream().copyTo(out) }
            }
            if (!tmp.renameTo(dest)) throw BridgeException("storage", "Не удалось сохранить файл")
        } catch (e: IOException) {
            tmp.delete()
            throw BridgeException("network", "Сервер недоступен: ${e.message ?: "нет связи"}")
        }
    }

    override val available: Boolean get() = signedIn && user?.ai?.enabled == true

    private fun schedulePush() {
        if (!signedIn) return
        pendingPush?.cancel()
        pendingPush = scope.launch {
            delay(PUSH_DEBOUNCE_MS)
            if (network.online) runCatching { sync() }
        }
    }

    private fun saveUser(u: ServerUserDto?) {
        user = u
        proxies.setServerProxy(u?.proxy?.toProxy())
        emit()
    }

    private fun emit() = EventBus.emit("serverState", status())

    private fun ServerProxyDto.toProxy() = ProxyDto(ProxyManager.SERVER_ID, type, host, port, user, pass, "Бесплатный прокси You Music")

    private fun <T> request(path: String, method: String, body: String?, serializer: KSerializer<T>, auth: Boolean = true): T =
        BridgeJson.decodeFromString(serializer, requestBlocking(path, method, body, auth = auth))

    private fun requestBlocking(path: String, method: String, body: String?, auth: Boolean = true, timeoutSec: Long = 30): String {
        if (!network.online) throw BridgeException("offline", "Нет сети")
        val request = Request.Builder()
            .url(BASE_URL + path)
            .method(method, body?.toRequestBody("application/json".toMediaType()))
            .apply { if (auth) token?.let { header("Authorization", "Bearer $it") } }
            .build()
        val client = Http.client.newBuilder().readTimeout(timeoutSec, TimeUnit.SECONDS).build()
        try {
            client.newCall(request).execute().use { r ->
                val text = r.body.string()
                if (r.isSuccessful) return text
                val err = runCatching { BridgeJson.parseToJsonElement(text).jsonObject }.getOrNull()
                val code = err?.get("error")?.jsonPrimitive?.contentOrNull ?: "server"
                val message = err?.get("message")?.jsonPrimitive?.contentOrNull ?: "Сервер ответил ${r.code}"
                throw BridgeException(code, message)
            }
        } catch (e: IOException) {
            throw BridgeException("network", "Сервер недоступен: ${e.message ?: "нет связи"}")
        }
    }

    companion object {
        const val BASE_URL = "https://grzxk.ru/youmusic"
        private const val TOKEN = "token"
        private const val USER = "user"
        private const val SYNCED_AT = "syncedAt"
        private const val REMOTE_AT = "remoteAt"
        private const val PUSH_DEBOUNCE_MS = 20_000L
    }
}
