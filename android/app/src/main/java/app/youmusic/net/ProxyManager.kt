package app.youmusic.net

import android.net.Uri
import app.youmusic.bridge.BridgeException
import app.youmusic.bridge.BridgeJson
import app.youmusic.bridge.EventBus
import app.youmusic.data.KeyValueStore
import kotlinx.serialization.Serializable
import okhttp3.Request
import java.util.UUID

@Serializable
data class ProxyDto(
    val id: String,
    val type: String,
    val host: String,
    val port: Int,
    val user: String? = null,
    val pass: String? = null,
    val name: String? = null,
    val pingMs: Long? = null,
)

@Serializable
data class ProxyStateDto(
    val proxies: List<ProxyDto>,
    val activeId: String? = null,
    val enabled: Boolean = false,
    val vpnActive: Boolean = false,
    /** True when traffic actually goes through the proxy right now. */
    val inUse: Boolean = false,
)

@Serializable
private data class StoredProxies(val proxies: List<ProxyDto> = emptyList(), val activeId: String? = null, val enabled: Boolean = false)

/**
 * User proxies (SOCKS5 / HTTP) for all app traffic: YouTube API, streams, downloads.
 * Never used while a system VPN is active — the VPN already routes traffic and stacking both breaks playback.
 */
class ProxyManager(private val kv: KeyValueStore, private val network: NetworkMonitor, private val onRouteChanged: () -> Unit) {
    private var stored: StoredProxies = load()

    private fun load() = kv.get(KEY)?.let { runCatching { BridgeJson.decodeFromString(StoredProxies.serializer(), it) }.getOrNull() } ?: StoredProxies()

    /** Re-reads the saved list (after restoring a backup). */
    fun reload() {
        stored = load()
        apply()
    }

    init {
        apply(notify = false)
        network.onChange { old, new -> if (old.vpn != new.vpn) apply() }
    }

    fun state(): ProxyStateDto {
        val active = stored.proxies.firstOrNull { it.id == stored.activeId }
        return ProxyStateDto(stored.proxies, stored.activeId, stored.enabled, network.vpn, stored.enabled && active != null && !network.vpn)
    }

    fun add(link: String): ProxyDto {
        val proxy = parse(link)
        val existing = stored.proxies.firstOrNull { it.host == proxy.host && it.port == proxy.port && it.type == proxy.type }
        if (existing != null) return existing
        save(stored.copy(proxies = stored.proxies + proxy, activeId = stored.activeId ?: proxy.id))
        return proxy
    }

    fun remove(id: String) {
        val rest = stored.proxies.filter { it.id != id }
        save(stored.copy(proxies = rest, activeId = if (stored.activeId == id) rest.firstOrNull()?.id else stored.activeId))
    }

    fun select(id: String) = save(stored.copy(activeId = id, enabled = true))

    fun setEnabled(enabled: Boolean) = save(stored.copy(enabled = enabled))

    /** Round-trip time of a small YouTube request through the proxy, or -1 when it fails. */
    fun ping(id: String): Long {
        val p = stored.proxies.firstOrNull { it.id == id } ?: throw BridgeException("not_found", "Прокси не найден")
        val client = Http.withProxy(p.config()).newBuilder().callTimeout(java.time.Duration.ofSeconds(8)).build()
        val started = System.nanoTime()
        val ms = runCatching {
            client.newCall(Request.Builder().url(PING_URL).header("User-Agent", Http.DESKTOP_UA).build()).execute().use {
                if (it.code in 200..399) (System.nanoTime() - started) / 1_000_000 else -1L
            }
        }.getOrDefault(-1L)
        stored = stored.copy(proxies = stored.proxies.map { if (it.id == id) it.copy(pingMs = ms) else it })
        persist()
        EventBus.emit("proxyChanged", state())
        return ms
    }

    fun shareLink(id: String): String {
        val p = stored.proxies.firstOrNull { it.id == id } ?: throw BridgeException("not_found", "Прокси не найден")
        val b = Uri.Builder().scheme("youmusic").authority(if (p.type == "http") "http" else "socks")
            .appendQueryParameter("server", p.host).appendQueryParameter("port", p.port.toString())
        p.user?.let { b.appendQueryParameter("user", it) }
        p.pass?.let { b.appendQueryParameter("pass", it) }
        return b.build().toString()
    }

    private fun save(next: StoredProxies) {
        stored = next
        persist()
        apply()
    }

    private fun persist() = kv.set(KEY, BridgeJson.encodeToString(StoredProxies.serializer(), stored))

    private fun apply(notify: Boolean = true) {
        val state = state()
        val active = stored.proxies.firstOrNull { it.id == stored.activeId }
        Http.useProxy(if (state.inUse) active?.config() else null)
        if (notify) {
            onRouteChanged()
            EventBus.emit("proxyChanged", state)
        }
    }

    private fun ProxyDto.config() = ProxyConfig(type, host, port, user, pass)

    companion object {
        private const val KEY = "native.proxies"
        private const val PING_URL = "https://www.youtube.com/generate_204"

        /**
         * Accepts: socks5://user:pass@host:port, http://host:port, host:port[:user:pass],
         * https://t.me/socks?server=…&port=…&user=…&pass=…, tg://socks?…, youmusic://socks?… / youmusic://http?…
         * and youmusic://proxy?url=<any of the above>.
         */
        fun parse(raw: String): ProxyDto {
            val link = raw.trim()
            val uri = Uri.parse(link)
            if (uri.scheme == "youmusic" && uri.host == "proxy") {
                return parse(uri.getQueryParameter("url") ?: throw BridgeException("bad_request", "В ссылке нет адреса прокси"))
            }
            val isTelegramStyle = (uri.scheme == "tg" || uri.scheme == "youmusic") ||
                (uri.host?.endsWith("t.me") == true && uri.path?.trim('/') in setOf("socks", "proxy"))
            if (isTelegramStyle) {
                if (uri.getQueryParameter("secret") != null) throw BridgeException("bad_request", "Это MTProto-прокси Telegram — он работает только в Telegram. Нужен SOCKS5 или HTTP.")
                val server = uri.getQueryParameter("server") ?: throw BridgeException("bad_request", "В ссылке нет server")
                val port = uri.getQueryParameter("port")?.toIntOrNull() ?: throw BridgeException("bad_request", "В ссылке нет port")
                val type = if (uri.host == "http" || uri.path?.trim('/') == "http") "http" else "socks5"
                return ProxyDto(UUID.randomUUID().toString(), type, server, port, uri.getQueryParameter("user"), uri.getQueryParameter("pass"))
            }
            if (uri.scheme in setOf("socks", "socks5", "socks5h", "http", "https") && uri.host != null && uri.port > 0) {
                val info = uri.userInfo?.split(':', limit = 2)
                val type = if (uri.scheme!!.startsWith("socks")) "socks5" else "http"
                return ProxyDto(UUID.randomUUID().toString(), type, uri.host!!, uri.port, info?.getOrNull(0)?.let(Uri::decode), info?.getOrNull(1)?.let(Uri::decode))
            }
            val parts = link.split(':')
            if (parts.size == 2 || parts.size == 4) {
                val port = parts[1].toIntOrNull()
                if (port != null && port in 1..65535) return ProxyDto(UUID.randomUUID().toString(), "socks5", parts[0], port, parts.getOrNull(2), parts.getOrNull(3))
            }
            throw BridgeException("bad_request", "Не удалось распознать прокси. Примеры: socks5://user:pass@1.2.3.4:1080, http://1.2.3.4:8080, 1.2.3.4:1080")
        }
    }
}
