package app.youmusic.source

import android.util.LruCache
import app.youmusic.bridge.BridgeJson
import app.youmusic.model.LyricsDto
import app.youmusic.net.Http
import kotlinx.serialization.Serializable
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request

/** Lyrics from LRCLIB (open database, no key, no account). Missing lyrics are a normal outcome. */
class LyricsRepository {
    private val cache = LruCache<String, LyricsDto>(64)

    @Serializable
    private data class LrclibTrack(val plainLyrics: String? = null, val syncedLyrics: String? = null, val instrumental: Boolean = false)

    fun lyrics(artist: String, title: String, durationMs: Long): LyricsDto {
        val key = "$artist|$title"
        cache.get(key)?.let { return it }
        val url = "https://lrclib.net/api/get".toHttpUrl().newBuilder()
            .addQueryParameter("artist_name", artist)
            .addQueryParameter("track_name", title)
            .apply { if (durationMs > 0) addQueryParameter("duration", (durationMs / 1000).toString()) }
            .build()
        val result = Http.client.newCall(Request.Builder().url(url).header("User-Agent", "YouMusic (personal player)").build())
            .execute().use { r ->
                if (!r.isSuccessful) return@use LyricsDto()
                val t = BridgeJson.decodeFromString(LrclibTrack.serializer(), r.body.string())
                if (t.instrumental) LyricsDto(plain = "♪ Инструментал") else LyricsDto(t.plainLyrics, t.syncedLyrics)
            }
        cache.put(key, result)
        return result
    }
}
