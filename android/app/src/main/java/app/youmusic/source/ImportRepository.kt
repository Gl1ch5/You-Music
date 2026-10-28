package app.youmusic.source

import app.youmusic.bridge.BridgeException
import app.youmusic.bridge.BridgeJson
import app.youmusic.net.FreeProxies
import app.youmusic.net.Http
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.Request

@Serializable
data class ImportedTrackDto(
    val title: String,
    val artist: String,
    val durationMs: Long = 0,
    val artwork: String? = null,
    val album: String? = null,
)

@Serializable
data class ImportedListDto(
    val title: String,
    val source: String,
    val tracks: List<ImportedTrackDto>,
    /** Set when the list was read through a free public proxy ("1.2.3.4:8080"). */
    val via: String? = null,
)

/**
 * Reads track lists from other services by public link, without accounts:
 * Spotify (embed page data) and Yandex Music (public API). Matching to YouTube happens in the UI.
 * When Yandex refuses the current network (451 outside Russia / behind a VPN, captcha, timeouts), its requests
 * go through free Russian proxies found and checked on the fly ([FreeProxies]).
 */
class ImportRepository {
    /** Proxy that served the last Yandex request of the current import, if any. */
    private var via: String? = null

    suspend fun fetch(link: String): ImportedListDto {
        via = null
        return read(link).let { if (it.source == "yandex") it.copy(via = via) else it }
    }

    /** Top songs right now. Yandex is the only chart readable without an account (VK needs a sign-in). */
    suspend fun chart(source: String): ImportedListDto {
        via = null
        if (source != "yandex") throw BridgeException("bad_request", "Этот чарт пока недоступен")
        val tracks = runCatching {
            val result = yandexApi("landing3/chart")
            val chart = result["chart"] as? JsonObject ?: result
            (chart["tracks"] as? JsonArray).orEmpty().mapNotNull { ((it as? JsonObject)?.get("track") as? JsonObject)?.let(::yandexTrack) }
        }.getOrDefault(emptyList())
        // The "Чарт" playlist of the official yamusic-top account mirrors the same list.
        val list = tracks.ifEmpty { yandexPlaylist("users/yamusic-top/playlists/1076").tracks }
        return ImportedListDto("Чарт Яндекс Музыки", "yandex", list, via = via)
    }

    private suspend fun read(link: String): ImportedListDto {
        val url = link.trim()
        SPOTIFY.find(url)?.let { m -> return spotify(m.groupValues[1], m.groupValues[2]) }
        YANDEX_USER_PLAYLIST.find(url)?.let { m -> return yandexPlaylist("users/${m.groupValues[1]}/playlists/${m.groupValues[2]}") }
        YANDEX_PLAYLIST.find(url)?.let { m -> return yandexPlaylist("playlist/${m.groupValues[1]}") }
        YANDEX_ALBUM.find(url)?.let { m -> return yandexAlbum(m.groupValues[1]) }
        YANDEX_LIKES.find(url)?.let { m -> return yandexPlaylist("users/${m.groupValues[1]}/playlists/3", "Мне нравится (Яндекс)") }
        throw BridgeException("bad_request", "Нужна ссылка на плейлист или альбом Spotify или Яндекс Музыки")
    }

    private fun get(url: String, headers: Map<String, String> = emptyMap()): Pair<Int, String> {
        val builder = Request.Builder().url(url).header("User-Agent", Http.DESKTOP_UA)
        headers.forEach { (k, v) -> builder.header(k, v) }
        Http.client.newCall(builder.build()).execute().use { return it.code to it.body.string() }
    }

    private fun spotify(type: String, id: String): ImportedListDto {
        val (code, html) = get("https://open.spotify.com/embed/$type/$id")
        if (code != 200) throw BridgeException("not_found", "Spotify не отдал плейлист (код $code). Он должен быть публичным.")
        val json = NEXT_DATA.find(html)?.groupValues?.get(1) ?: throw BridgeException("extraction", "Spotify изменил страницу — не удалось прочитать список")
        val entity = BridgeJson.parseToJsonElement(json).obj("props")?.obj("pageProps")?.obj("state")?.obj("data")?.obj("entity")
            ?: throw BridgeException("extraction", "Spotify изменил страницу — не удалось прочитать список")
        // An album shares one cover; playlists carry no per-track art in the embed (recommendations data fills it in later).
        val albumCover = if (type == "album") {
            ((entity.obj("coverArt")?.get("sources") as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
                .maxByOrNull { it["width"]?.jsonPrimitive?.longOrNull ?: 0 })?.str("url")
        } else null
        val list = (entity["trackList"] as? JsonArray).orEmpty().mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            ImportedTrackDto(o.str("title") ?: return@mapNotNull null, o.str("subtitle").orEmpty(), o["duration"]?.jsonPrimitive?.longOrNull ?: 0, artwork = albumCover)
        }
        val singleTrack = if (type == "track") listOf(ImportedTrackDto(entity.str("name").orEmpty(), entity.str("subtitle").orEmpty(), entity["duration"]?.jsonPrimitive?.longOrNull ?: 0)) else emptyList()
        return ImportedListDto(entity.str("name") ?: "Spotify", "spotify", list.ifEmpty { singleTrack })
    }

    /**
     * Direct first; on 451, a captcha page instead of JSON or a network failure — through free proxies.
     * 404/401/403 are real answers about the playlist and are returned as is.
     */
    private suspend fun yandexGet(url: String): Pair<Int, String> {
        val headers = mapOf("X-Yandex-Music-Client" to "YandexMusicAndroid/24023621")
        val direct = runCatching { get(url, headers) }.getOrNull()
        if (direct != null && direct.first != 451 && !(direct.first == 200 && !direct.second.trimStart().startsWith("{"))) return direct
        val request = Request.Builder().url(url).header("User-Agent", Http.DESKTOP_UA).apply { headers.forEach { (k, v) -> header(k, v) } }.build()
        val proxied = FreeProxies.fetch(request) { code, body ->
            (code to body).takeIf { code in setOf(200, 401, 403, 404) && body.trimStart().startsWith("{") }
        }
        if (proxied != null) {
            via = FreeProxies.describe(proxied.first)
            return proxied.second
        }
        if (direct != null && direct.first == 451) {
            throw BridgeException("unavailable", "Яндекс Музыка недоступна из этой сети, и бесплатные прокси сейчас не ответили. Выключите VPN на время переноса или попробуйте ещё раз.")
        }
        throw BridgeException("network", "Не удалось связаться с Яндекс Музыкой ни напрямую, ни через бесплатные прокси")
    }

    private suspend fun yandexApi(path: String): JsonObject {
        val sep = if ('?' in path) '&' else '?'
        val (code, body) = yandexGet("https://api.music.yandex.net/$path${sep}rich-tracks=true")
        if (code == 404) throw BridgeException("not_found", "Плейлист не найден или скрыт. Сделайте его публичным.")
        if (code == 401 || code == 403) throw BridgeException("not_found", "Плейлист закрыт. Откройте доступ по ссылке в Яндекс Музыке.")
        if (code != 200) throw BridgeException("network", "Яндекс Музыка ответила кодом $code")
        return BridgeJson.parseToJsonElement(body).jsonObject["result"] as? JsonObject
            ?: throw BridgeException("extraction", "Неожиданный ответ Яндекс Музыки")
    }

    private suspend fun yandexPlaylist(path: String, fallbackTitle: String = "Яндекс Музыка"): ImportedListDto {
        val result = yandexApi(path)
        val entries = (result["tracks"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        val full = entries.mapNotNull { (it["track"] as? JsonObject) }
        val tracks = if (full.size == entries.size) full else yandexTracks(entries.mapNotNull { e ->
            val id = e.str("id") ?: return@mapNotNull null
            e.str("albumId")?.let { "$id:$it" } ?: id
        })
        return ImportedListDto(result.str("title") ?: fallbackTitle, "yandex", tracks.mapNotNull(::yandexTrack))
    }

    private suspend fun yandexAlbum(id: String): ImportedListDto {
        val result = yandexApi("albums/$id/with-tracks")
        val tracks = (result["volumes"] as? JsonArray).orEmpty().flatMap { (it as? JsonArray).orEmpty() }.mapNotNull { it as? JsonObject }
        return ImportedListDto(result.str("title") ?: "Альбом", "yandex", tracks.mapNotNull(::yandexTrack))
    }

    /** Large playlists come back as bare ids; resolve them in batches. */
    private suspend fun yandexTracks(ids: List<String>): List<JsonObject> = ids.chunked(100).flatMap { batch ->
        val (code, body) = yandexGet("https://api.music.yandex.net/tracks?track-ids=${batch.joinToString(",")}")
        if (code != 200) return@flatMap emptyList()
        (BridgeJson.parseToJsonElement(body).jsonObject["result"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
    }

    private fun yandexTrack(t: JsonObject): ImportedTrackDto? {
        val title = t.str("title") ?: return null
        val version = t.str("version")
        val artists = (t["artists"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonObject)?.str("name") }
        val album = (t["albums"] as? JsonArray)?.firstOrNull() as? JsonObject
        // "avatars.yandex.net/get-yandex-music-content/…/%%" — the size goes in place of %%.
        val cover = (t.str("coverUri") ?: album?.str("coverUri"))?.let { "https://" + it.replace("%%", "1000x1000") }
        return ImportedTrackDto(
            if (version.isNullOrBlank()) title else "$title ($version)",
            artists.joinToString(", "),
            t["durationMs"]?.jsonPrimitive?.longOrNull ?: 0,
            artwork = cover,
            album = album?.str("title"),
        )
    }

    private fun JsonElement.obj(key: String): JsonObject? = (this as? JsonObject)?.get(key) as? JsonObject
    private fun JsonObject.str(key: String): String? = (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull

    companion object {
        private val SPOTIFY = Regex("""open\.spotify\.com/(?:intl-[a-z]+/)?(playlist|album|track)/([A-Za-z0-9]+)""")
        private val YANDEX_USER_PLAYLIST = Regex("""music\.yandex\.[a-z]+/users/([^/?#]+)/playlists/(\d+)""")
        private val YANDEX_PLAYLIST = Regex("""music\.yandex\.[a-z]+/playlists/([A-Za-z0-9.-]+)""")
        private val YANDEX_ALBUM = Regex("""music\.yandex\.[a-z]+/album/(\d+)(?:[/?#]|$)""")
        private val YANDEX_LIKES = Regex("""music\.yandex\.[a-z]+/users/([^/?#]+)/tracks""")
        private val NEXT_DATA = Regex("""<script id="__NEXT_DATA__" type="application/json">(.*?)</script>""", RegexOption.DOT_MATCHES_ALL)
    }
}
