package app.youmusic.player

import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import app.youmusic.bridge.BridgeJson
import app.youmusic.data.AppPaths
import app.youmusic.model.TrackDto

/** Remote tracks are queued as `ym://yt/<videoId>`; the data source resolves them at load time. */
const val YM_SCHEME = "ym"
private const val EXTRA_TRACK = "track"

fun TrackDto.playbackUri(): Uri = when (source) {
    "yt" -> Uri.parse("$YM_SCHEME://yt/${id.removePrefix("yt:")}")
    else -> Uri.parse(url ?: error("Local track without uri"))
}

fun TrackDto.toMediaItem(paths: AppPaths): MediaItem {
    val json = BridgeJson.encodeToString(TrackDto.serializer(), this)
    val extras = Bundle().apply { putString(EXTRA_TRACK, json) }
    val uri = playbackUri()
    return MediaItem.Builder()
        .setMediaId(id)
        .setUri(uri)
        .setRequestMetadata(MediaItem.RequestMetadata.Builder().setMediaUri(uri).setExtras(extras).build())
        .setMediaMetadata(
            MediaMetadata.Builder()
                .setTitle(title)
                .setArtist(artist)
                .setAlbumTitle(album)
                .setArtworkUri(paths.platformArtwork(id, artwork?.takeIf { it.startsWith("http") && !it.startsWith(app.youmusic.bridge.BridgeHost.ORIGIN) }))
                .setExtras(extras)
                .build(),
        )
        .build()
}

fun MediaItem.track(): TrackDto? {
    val json = mediaMetadata.extras?.getString(EXTRA_TRACK) ?: requestMetadata.extras?.getString(EXTRA_TRACK) ?: return null
    return runCatching { BridgeJson.decodeFromString(TrackDto.serializer(), json) }.getOrNull()
}

/** Controllers strip local configuration; the session rebuilds the uri from request metadata. */
fun MediaItem.withPlaybackUri(): MediaItem =
    if (localConfiguration != null) this else buildUpon().setUri(requestMetadata.mediaUri).build()
