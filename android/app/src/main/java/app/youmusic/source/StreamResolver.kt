package app.youmusic.source

import android.net.Uri
import app.youmusic.data.KeyValueStore
import app.youmusic.net.Http
import org.schabi.newpipe.extractor.MediaFormat
import org.schabi.newpipe.extractor.exceptions.ContentNotAvailableException
import org.schabi.newpipe.extractor.services.youtube.YoutubeParsingHelper
import org.schabi.newpipe.extractor.stream.AudioStream
import org.schabi.newpipe.extractor.stream.AudioTrackType
import org.schabi.newpipe.extractor.stream.DeliveryMethod
import java.util.concurrent.ConcurrentHashMap

data class ResolvedStream(
    val url: String,
    val format: MediaFormat?,
    val bitrate: Int,
    val expiresAt: Long,
    val userAgent: String,
) {
    val extension: String get() = format?.suffix ?: "m4a"
}

/** Picks and caches a direct audio URL for a video. URLs expire, so entries are refreshed shortly before. */
class StreamResolver(private val youtube: YouTubeRepository, private val kv: KeyValueStore) {
    private val cache = ConcurrentHashMap<String, ResolvedStream>()

    fun resolve(videoId: String, forDownload: Boolean = false, qualityOverride: String? = null): ResolvedStream {
        val quality = qualityOverride ?: kv.settings.let { if (forDownload) it.downloadQuality else it.streamQuality }
        val key = "$videoId|$quality|$forDownload"
        cache[key]?.takeIf { it.expiresAt > System.currentTimeMillis() }?.let { return it }
        val info = youtube.streamInfo(videoId, maxAgeMs = 60 * 60_000L)
        val stream = pick(info.audioStreams, quality, preferM4a = forDownload)
            ?: throw ContentNotAvailableException("Нет аудиопотока для этого трека")
        val expire = Uri.parse(stream.content).getQueryParameter("expire")?.toLongOrNull()?.times(1000)
            ?: (System.currentTimeMillis() + 3 * 60 * 60_000L)
        return ResolvedStream(
            url = stream.content,
            format = stream.format,
            bitrate = stream.averageBitrate,
            expiresAt = expire - 10 * 60_000L,
            userAgent = userAgentFor(stream.content),
        ).also { cache[key] = it }
    }

    fun invalidate(videoId: String) {
        cache.keys.removeAll { it.startsWith("$videoId|") }
    }

    private fun pick(streams: List<AudioStream>, quality: String, preferM4a: Boolean): AudioStream? {
        val progressive = streams.filter { it.isUrl && it.deliveryMethod == DeliveryMethod.PROGRESSIVE_HTTP }
        val usable = progressive
            .filter { it.audioTrackType == null || it.audioTrackType == AudioTrackType.ORIGINAL }
            .ifEmpty { progressive }
        if (usable.isEmpty()) return null
        val pool = if (preferM4a) usable.filter { it.format == MediaFormat.M4A }.ifEmpty { usable } else usable
        val sorted = pool.sortedBy { it.averageBitrate }
        return when (quality) {
            "low" -> sorted.first()
            "normal" -> sorted.lastOrNull { it.averageBitrate in 1..130 } ?: sorted.first()
            else -> sorted.last()
        }
    }

    private fun userAgentFor(url: String): String = when {
        url.contains("c=ANDROID") -> YoutubeParsingHelper.getAndroidUserAgent(null)
        url.contains("c=IOS") -> YoutubeParsingHelper.getIosUserAgent(null)
        else -> Http.DESKTOP_UA
    }
}
