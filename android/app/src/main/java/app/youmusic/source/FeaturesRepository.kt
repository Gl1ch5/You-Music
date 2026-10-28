package app.youmusic.source

import app.youmusic.bridge.BridgeJson
import app.youmusic.net.Http
import app.youmusic.net.await
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import java.io.File
import kotlin.math.abs

@Serializable
data class FeatureQueryDto(val id: String, val artist: String, val title: String, val durationMs: Long = 0)

/** Basic audio data of a song for recommendations. `found = false` = Deezer does not know it (cached too). */
@Serializable
data class TrackFeaturesDto(
    val found: Boolean = false,
    val bpm: Double? = null,
    /** Deezer ReplayGain-like value in dB: more negative = louder master. */
    val gainDb: Double? = null,
    val genres: List<String> = emptyList(),
    val explicit: Boolean = false,
    val year: Int? = null,
)

/**
 * Tempo, loudness and genres from the public Deezer API (no key, no account): search by artist + title,
 * then the track and its album. Results are cached on disk by track id, so each song is looked up once.
 */
class FeaturesRepository(private val file: File) {
    private val lock = Mutex()
    private var cache: MutableMap<String, TrackFeaturesDto>? = null
    private var dirty = false
    private val gate = Semaphore(6)
    private val serializer = MapSerializer(String.serializer(), TrackFeaturesDto.serializer())

    suspend fun features(tracks: List<FeatureQueryDto>): Map<String, TrackFeaturesDto> {
        val known = lock.withLock { loaded().filterKeys { k -> tracks.any { it.id == k } } }
        val missing = tracks.filter { it.id !in known }.distinctBy { it.id }.take(MAX_PER_CALL)
        val fresh = coroutineScope {
            missing.map { q ->
                async(Dispatchers.IO) { gate.withPermit { q.id to runCatching { lookup(q) }.getOrNull() } }
            }.awaitAll()
        }
        lock.withLock {
            val map = loaded()
            // Network failures are not cached: they are retried next time.
            fresh.forEach { (id, f) -> if (f != null) map[id] = f }
            if (fresh.any { it.second != null }) dirty = true
            if (dirty) save(map)
        }
        return known + fresh.mapNotNull { (id, f) -> f?.let { id to it } }
    }

    private fun loaded(): MutableMap<String, TrackFeaturesDto> {
        cache?.let { return it }
        val map = runCatching { BridgeJson.decodeFromString(serializer, file.readText()).toMutableMap() }.getOrElse { mutableMapOf() }
        cache = map
        return map
    }

    private fun save(map: MutableMap<String, TrackFeaturesDto>) {
        // Keep the file small: drop the oldest entries beyond the limit (maps keep insertion order).
        while (map.size > MAX_CACHED) map.remove(map.keys.first())
        runCatching {
            val tmp = File(file.parentFile, file.name + ".tmp")
            tmp.writeText(BridgeJson.encodeToString(serializer, map))
            tmp.renameTo(file)
        }
        dirty = false
    }

    private suspend fun json(url: String): JsonObject {
        val req = Request.Builder().url(url).header("User-Agent", Http.DESKTOP_UA).build()
        return Http.client.newCall(req).await().use { r ->
            if (!r.isSuccessful) throw java.io.IOException("HTTP ${r.code}")
            BridgeJson.parseToJsonElement(r.body.string()).jsonObject
        }
    }

    private suspend fun lookup(q: FeatureQueryDto): TrackFeaturesDto {
        val artist = q.artist.split(',', '&').first().trim()
        val title = q.title.replace(BRACKETS, "").trim()
        val strict = search("artist:\"$artist\" track:\"$title\"")
        val hit = best(strict, q) ?: best(search("$artist $title"), q) ?: return TrackFeaturesDto(found = false)
        val id = hit["id"].long() ?: return TrackFeaturesDto(found = false)
        val track = json("https://api.deezer.com/track/$id")
        val albumId = (track["album"] as? JsonObject)?.get("id").long()
        val album = albumId?.let { runCatching { json("https://api.deezer.com/album/$it") }.getOrNull() }
        val genres = ((album?.get("genres") as? JsonObject)?.get("data") as? JsonArray).orEmpty()
            .mapNotNull { ((it as? JsonObject)?.get("name") as? JsonPrimitive)?.contentOrNull }
        return TrackFeaturesDto(
            found = true,
            bpm = track["bpm"].double()?.takeIf { it > 0 },
            gainDb = track["gain"].double(),
            genres = genres,
            explicit = (track["explicit_lyrics"] as? JsonPrimitive)?.booleanOrNull ?: false,
            year = (track["release_date"] as? JsonPrimitive)?.contentOrNull?.take(4)?.toIntOrNull(),
        )
    }

    private suspend fun search(query: String): List<JsonObject> {
        val url = "https://api.deezer.com/search".toHttpUrl().newBuilder().addQueryParameter("q", query).addQueryParameter("limit", "10").build()
        return (json(url.toString())["data"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
    }

    /** Closest duration among results whose title shares a word with ours. */
    private fun best(items: List<JsonObject>, q: FeatureQueryDto): JsonObject? {
        val words = q.title.lowercase().split(Regex("\\W+")).filter { it.length > 2 }.toSet()
        val plausible = items.filter { item ->
            val t = (item["title"] as? JsonPrimitive)?.contentOrNull?.lowercase().orEmpty()
            words.isEmpty() || words.any { it in t }
        }
        if (q.durationMs <= 0) return plausible.firstOrNull()
        return plausible
            .map { it to abs((it["duration"].long() ?: 0) * 1000 - q.durationMs) }
            .filter { it.second < 20_000 }
            .minByOrNull { it.second }?.first
    }

    private fun kotlinx.serialization.json.JsonElement?.long(): Long? = (this as? JsonPrimitive)?.longOrNull
    private fun kotlinx.serialization.json.JsonElement?.double(): Double? = (this as? JsonPrimitive)?.doubleOrNull

    companion object {
        private val BRACKETS = Regex("""\s*[(\[].*?[)\]]""")
        private const val MAX_PER_CALL = 40
        private const val MAX_CACHED = 5000
    }
}
