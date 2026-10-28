package app.youmusic.source

import android.util.LruCache
import app.youmusic.bridge.BridgeJson
import app.youmusic.model.LyricsDto
import app.youmusic.net.Http
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request

/**
 * Lyrics from LRCLIB (open database, no key, no account). Missing lyrics are a normal outcome.
 * Titles from YouTube are often noisy ("Song (feat. X)", "Artist - Topic"), so after the exact lookup the search
 * endpoint is tried with cleaned variants, and the hit closest in length wins — synced lyrics preferred.
 */
class LyricsRepository {
    private val cache = LruCache<String, LyricsDto>(64)

    @Serializable
    private data class LrclibTrack(
        val trackName: String? = null,
        val artistName: String? = null,
        val duration: Double? = null,
        val plainLyrics: String? = null,
        val syncedLyrics: String? = null,
        val instrumental: Boolean = false,
    )

    fun lyrics(artist: String, title: String, durationMs: Long): LyricsDto {
        val key = "$artist|$title"
        cache.get(key)?.let { return it }
        val cleanArtist = cleanArtist(artist)
        val firstArtist = cleanArtist.split(Regex("""\s*(?:,|&|\bfeat\.?|\bft\.?|\sx\s|×)\s*""", RegexOption.IGNORE_CASE)).first().trim()
        val cleanTitle = cleanTitle(title)
        val found = exact(cleanArtist, cleanTitle, durationMs)
            ?: exact(firstArtist, cleanTitle, durationMs).takeIf { firstArtist != cleanArtist }
            ?: best(searchUrl { addQueryParameter("track_name", cleanTitle).addQueryParameter("artist_name", firstArtist) }, durationMs)
            ?: best(searchUrl { addQueryParameter("q", "$firstArtist $cleanTitle") }, durationMs)
        val result = when {
            found == null -> LyricsDto()
            found.instrumental -> LyricsDto(plain = "♪ Инструментал")
            else -> LyricsDto(found.plainLyrics, found.syncedLyrics)
        }
        cache.put(key, result)
        return result
    }

    private fun exact(artist: String, title: String, durationMs: Long): LrclibTrack? {
        val url = "https://lrclib.net/api/get".toHttpUrl().newBuilder()
            .addQueryParameter("artist_name", artist)
            .addQueryParameter("track_name", title)
            .apply { if (durationMs > 0) addQueryParameter("duration", (durationMs / 1000).toString()) }
            .build()
        return runCatching { get(url)?.let { BridgeJson.decodeFromString(LrclibTrack.serializer(), it) } }.getOrNull()
            ?.takeIf { it.instrumental || !it.plainLyrics.isNullOrBlank() || !it.syncedLyrics.isNullOrBlank() }
    }

    private fun searchUrl(params: HttpUrl.Builder.() -> HttpUrl.Builder): HttpUrl =
        "https://lrclib.net/api/search".toHttpUrl().newBuilder().params().build()

    /** Closest length within 6 s (any length when unknown); synced lyrics beat plain ones. */
    private fun best(url: HttpUrl, durationMs: Long): LrclibTrack? {
        val list = runCatching { get(url)?.let { BridgeJson.decodeFromString(ListSerializer(LrclibTrack.serializer()), it) } }.getOrNull().orEmpty()
        val sec = durationMs / 1000.0
        return list
            .filter { it.instrumental || !it.plainLyrics.isNullOrBlank() || !it.syncedLyrics.isNullOrBlank() }
            .filter { sec <= 0 || it.duration == null || kotlin.math.abs(it.duration - sec) <= 6 }
            .minByOrNull { (if (it.syncedLyrics.isNullOrBlank()) 10.0 else 0.0) + if (sec > 0 && it.duration != null) kotlin.math.abs(it.duration - sec) else 3.0 }
    }

    private fun get(url: HttpUrl): String? =
        Http.client.newCall(Request.Builder().url(url).header("User-Agent", "YouMusic (personal player)").build()).execute().use { r ->
            if (r.isSuccessful) r.body.string() else null
        }

    companion object {
        fun cleanArtist(a: String) = a.replace(Regex("""\s+-\s+Topic$""", RegexOption.IGNORE_CASE), "").replace(Regex("VEVO$"), "").trim()

        /** "Song (feat. X) [Official Video]" → "Song"; keeps the whole title when nothing else is left. */
        fun cleanTitle(t: String): String {
            val stripped = t.replace(Regex("""\s*[(\[][^)\]]*[)\]]"""), "")
                .replace(Regex("""\s+(?:feat\.?|ft\.?)\s.*$""", RegexOption.IGNORE_CASE), "")
                .trim()
            return stripped.ifBlank { t.trim() }
        }
    }
}
