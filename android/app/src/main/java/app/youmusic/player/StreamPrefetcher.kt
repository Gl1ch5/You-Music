package app.youmusic.player

import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import app.youmusic.download.DownloadRepository
import app.youmusic.net.NetworkMonitor
import app.youmusic.source.StreamResolver
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Resolves the stream URL of the upcoming track while the current one plays, so skipping or auto-advancing
 * starts without waiting for YouTube extraction.
 */
class StreamPrefetcher(
    private val player: Player,
    private val resolver: StreamResolver,
    private val downloads: DownloadRepository,
    private val network: NetworkMonitor,
    private val scope: CoroutineScope,
) : Player.Listener {

    override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) = prefetchNext()

    override fun onTimelineChanged(timeline: androidx.media3.common.Timeline, reason: Int) = prefetchNext()

    private fun prefetchNext() {
        if (!network.online) return
        val next = player.nextMediaItemIndex.takeIf { it != androidx.media3.common.C.INDEX_UNSET } ?: return
        val uri = player.getMediaItemAt(next).localConfiguration?.uri ?: return
        if (uri.scheme != YM_SCHEME) return
        val videoId = uri.lastPathSegment ?: return
        if (downloads.isDownloaded("yt:$videoId")) return
        scope.launch { runCatching { resolver.resolveOrAlternative(videoId, uri.getQueryParameter("q"), uri.getQueryParameter("d")?.toLongOrNull() ?: 0) } }
    }
}
