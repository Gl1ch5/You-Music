package app.youmusic.player

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import androidx.annotation.OptIn
import androidx.media3.common.Format
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.cache.SimpleCache
import app.youmusic.download.DownloadRepository
import app.youmusic.model.TrackDto
import app.youmusic.source.StreamResolver
import kotlinx.serialization.Serializable
import java.io.File

/** Technical details of a track for the "О треке" sheet. Unknown values stay null. */
@Serializable
data class TrackInfoDto(
    /** download | cache | stream | local */
    val source: String,
    val container: String? = null,
    val codec: String? = null,
    val bitrateKbps: Int? = null,
    val sampleRateHz: Int? = null,
    val channels: Int? = null,
    val sizeBytes: Long? = null,
    val cachedBytes: Long? = null,
)

/** The decoder input format of what plays right now, reported by [PlaybackService]. */
@OptIn(UnstableApi::class)
object NowPlayingFormat {
    @Volatile var mediaId: String? = null
    @Volatile var format: Format? = null
}

@OptIn(UnstableApi::class)
class TrackInfoReader(
    private val context: Context,
    private val downloads: DownloadRepository,
    private val resolver: StreamResolver,
    private val cache: SimpleCache,
) {
    fun info(track: TrackDto): TrackInfoDto {
        val live = NowPlayingFormat.format?.takeIf { NowPlayingFormat.mediaId == track.id }
        val base = when {
            track.source == "local" -> fromFile(track.url?.let(Uri::parse), "local")
            downloads.localFile(track.id) != null -> fromFile(Uri.fromFile(downloads.localFile(track.id)), "download")
            else -> fromStream(track)
        }
        if (live == null) return base
        return base.copy(
            codec = base.codec ?: codecName(live.sampleMimeType ?: live.codecs),
            sampleRateHz = live.sampleRate.takeIf { it > 0 } ?: base.sampleRateHz,
            channels = live.channelCount.takeIf { it > 0 } ?: base.channels,
            bitrateKbps = base.bitrateKbps ?: live.bitrate.takeIf { it > 0 }?.div(1000),
        )
    }

    private fun fromStream(track: TrackDto): TrackInfoDto {
        val videoId = track.id.removePrefix("yt:")
        val stream = resolver.cached(videoId)
        val key = track.playbackUri().toString()
        val cached = runCatching { cache.getCachedSpans(key).sumOf { it.length } }.getOrDefault(0L)
        val size = stream?.contentLength?.takeIf { it > 0 }
        val full = size != null && cached >= size
        return TrackInfoDto(
            source = if (full) "cache" else "stream",
            container = stream?.format?.name?.lowercase(),
            codec = codecName(stream?.codec),
            bitrateKbps = stream?.bitrate?.takeIf { it > 0 }, // NewPipe reports kbps
            sampleRateHz = stream?.sampleRate?.takeIf { it > 0 },
            sizeBytes = size,
            cachedBytes = cached.takeIf { it > 0 },
        )
    }

    private fun fromFile(uri: Uri?, source: String): TrackInfoDto {
        if (uri == null) return TrackInfoDto(source)
        val r = MediaMetadataRetriever()
        return try {
            if (uri.scheme == "file") r.setDataSource(uri.path) else r.setDataSource(context, uri)
            val mime = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_MIMETYPE)
            val size = if (uri.scheme == "file") File(uri.path!!).length() else runCatching {
                context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length }
            }.getOrNull()
            TrackInfoDto(
                source = source,
                container = mime?.substringAfter('/')?.removePrefix("x-"),
                codec = codecName(mime),
                bitrateKbps = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE)?.toIntOrNull()?.div(1000),
                sampleRateHz = if (Build.VERSION.SDK_INT >= 31) r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_SAMPLERATE)?.toIntOrNull() else null,
                sizeBytes = size?.takeIf { it > 0 },
            )
        } catch (_: Exception) {
            TrackInfoDto(source)
        } finally {
            runCatching { r.release() }
        }
    }

    companion object {
        /** "audio/opus", "opus", "mp4a.40.2" → a name people know. */
        fun codecName(raw: String?): String? {
            val s = raw?.lowercase() ?: return null
            return when {
                "opus" in s -> "Opus"
                "flac" in s -> "FLAC"
                "mp4a" in s || "aac" in s || "mp4" in s || "m4a" in s -> "AAC"
                "vorbis" in s || "ogg" in s -> "Vorbis"
                "mpeg" in s || "mp3" in s -> "MP3"
                "alac" in s -> "ALAC"
                "wav" in s || "pcm" in s -> "WAV"
                else -> raw
            }
        }
    }
}
