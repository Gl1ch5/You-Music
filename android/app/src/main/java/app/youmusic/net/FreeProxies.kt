package app.youmusic.net

import app.youmusic.bridge.BridgeJson
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.time.Duration
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Public free proxies in Russia, used only by the import (Yandex Music answers 451 / captcha to foreign and VPN IPs).
 * Lists come from open aggregators; every candidate is checked by the real request itself, many at once,
 * and the first one that answers wins. Proxies that worked are kept for a while and tried first next time.
 * Nothing is stored on disk and no user traffic except the import goes through them.
 */
object FreeProxies {
    private val SOURCES = listOf(
        "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/countries/RU/data.txt",
        "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=ru&proxy_format=protocolipport&format=text&timeout=5000",
        "https://proxylist.geonode.com/api/proxy-list?country=RU&limit=200&page=1&sort_by=lastChecked&sort_type=desc",
    )
    private val LINE = Regex("""(?:(socks5|socks4|https?)://)?(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})""")
    private const val PARALLEL = 48
    private const val LIST_TTL_MS = 10 * 60_000L

    private var candidates: List<ProxyConfig> = emptyList()
    private var loadedAt = 0L
    private val working = ArrayDeque<ProxyConfig>()

    /** Short timeouts: a free proxy that is slow now is useless for an import anyway. */
    private fun clientFor(p: ProxyConfig): OkHttpClient = Http.withProxy(p).newBuilder()
        .connectTimeout(Duration.ofSeconds(4))
        .readTimeout(Duration.ofSeconds(6))
        .callTimeout(Duration.ofSeconds(8))
        .retryOnConnectionFailure(false)
        .build()

    /**
     * Runs [request] through free proxies until one gives an acceptable answer ([accept] returns non-null).
     * Returns the proxy and the result, or null when none worked.
     */
    suspend fun <T> fetch(request: Request, accept: (code: Int, body: String) -> T?): Pair<ProxyConfig, T>? {
        // Proxies that worked recently first, one by one: they are almost always still alive.
        for (p in working.toList()) {
            val r = runCatching { attempt(p, request, accept) }.getOrNull()
            if (r != null) return p to r
            working.remove(p)
        }
        val list = load().filter { it !in working }
        val found = firstWorking(list, request, accept) ?: return null
        working.addFirst(found.first)
        while (working.size > 5) working.removeLast()
        return found
    }

    fun describe(p: ProxyConfig): String = "${p.host}:${p.port}"

    private suspend fun <T> attempt(p: ProxyConfig, request: Request, accept: (Int, String) -> T?): T? =
        clientFor(p).newCall(request).await().use { accept(it.code, it.body.string()) }

    private suspend fun <T> firstWorking(list: List<ProxyConfig>, request: Request, accept: (Int, String) -> T?): Pair<ProxyConfig, T>? =
        coroutineScope {
            val winner = CompletableDeferred<Pair<ProxyConfig, T>?>()
            val gate = Semaphore(PARALLEL)
            val jobs = list.map { p ->
                launch(Dispatchers.IO) {
                    gate.withPermit {
                        if (winner.isCompleted) return@withPermit
                        val r = runCatching { attempt(p, request, accept) }.getOrNull()
                        if (r != null) winner.complete(p to r)
                    }
                }
            }
            launch { jobs.joinAll(); winner.complete(null) }
            val result = winner.await()
            // Cancelling the coroutines cancels their OkHttp calls too (see [await]).
            coroutineContext.cancelChildren()
            result
        }

    private suspend fun load(): List<ProxyConfig> {
        val now = System.currentTimeMillis()
        if (candidates.isNotEmpty() && now - loadedAt < LIST_TTL_MS) return candidates
        val lists = coroutineScope {
            SOURCES.map { url ->
                async(Dispatchers.IO) {
                    runCatching {
                        val req = Request.Builder().url(url).header("User-Agent", Http.DESKTOP_UA).build()
                        Http.client.newBuilder().callTimeout(Duration.ofSeconds(10)).build().newCall(req).await().use { r ->
                            if (r.isSuccessful) parse(r.body.string()) else emptyList()
                        }
                    }.getOrDefault(emptyList())
                }
            }.awaitAll()
        }
        candidates = lists.flatten().distinctBy { "${it.host}:${it.port}" }.shuffled()
        loadedAt = now
        return candidates
    }

    /** Plain "proto://ip:port" lines or Geonode JSON. SOCKS4 is skipped: OkHttp speaks SOCKS5 and HTTP CONNECT only. */
    private fun parse(text: String): List<ProxyConfig> {
        val trimmed = text.trimStart()
        if (trimmed.startsWith("{")) {
            val data = runCatching { BridgeJson.parseToJsonElement(trimmed).jsonObject["data"]?.jsonArray }.getOrNull() ?: return emptyList()
            return data.mapNotNull { e ->
                val o = e as? JsonObject ?: return@mapNotNull null
                val ip = o["ip"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                val port = o["port"]?.jsonPrimitive?.contentOrNull?.toIntOrNull() ?: return@mapNotNull null
                val protocols = (o["protocols"] as? JsonArray).orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }
                val type = when {
                    "socks5" in protocols -> "socks5"
                    "http" in protocols || "https" in protocols -> "http"
                    else -> return@mapNotNull null
                }
                ProxyConfig(type, ip, port, null, null)
            }
        }
        return LINE.findAll(text).mapNotNull { m ->
            val type = when (m.groupValues[1]) {
                "socks4" -> return@mapNotNull null
                "socks5" -> "socks5"
                else -> "http"
            }
            val port = m.groupValues[3].toIntOrNull()?.takeIf { it in 1..65535 } ?: return@mapNotNull null
            ProxyConfig(type, m.groupValues[2], port, null, null)
        }.toList()
    }
}

/** Suspends until the response arrives; cancelling the coroutine cancels the call. */
suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { runCatching { cancel() } }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (cont.isActive) cont.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            if (cont.isActive) cont.resume(response) else response.close()
        }
    })
}
