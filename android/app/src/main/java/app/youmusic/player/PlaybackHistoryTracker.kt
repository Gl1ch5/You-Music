package app.youmusic.player

import android.os.SystemClock
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import app.youmusic.data.LibraryRepository
import app.youmusic.model.TrackDto
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Records every play into history with how much was actually heard, and whether it was finished or skipped.
 * Recommendations use these signals (see web/src/logic/recommend.ts).
 */
class PlaybackHistoryTracker(
    private val player: Player,
    private val library: LibraryRepository,
    private val scope: CoroutineScope,
) : Player.Listener {
    private var current: TrackDto? = null
    private var durationMs = 0L
    private var listenedMs = 0L
    private var playingSince = -1L

    init {
        player.addListener(this)
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
        if (isPlaying) playingSince = SystemClock.elapsedRealtime() else accumulate()
    }

    override fun onPlaybackStateChanged(playbackState: Int) {
        if (playbackState == Player.STATE_READY) player.duration.takeIf { it > 0 }?.let { durationMs = it }
        if (playbackState == Player.STATE_ENDED) finish(endedNaturally = true, byUser = false)
    }

    override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
        finish(
            endedNaturally = reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO || reason == Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT,
            byUser = reason == Player.MEDIA_ITEM_TRANSITION_REASON_SEEK,
        )
        current = mediaItem?.track()
        durationMs = current?.durationMs ?: 0
        if (player.isPlaying) playingSince = SystemClock.elapsedRealtime()
    }

    fun flush() = finish(endedNaturally = false, byUser = false)

    private fun accumulate() {
        if (playingSince >= 0) {
            listenedMs += SystemClock.elapsedRealtime() - playingSince
            playingSince = -1
        }
    }

    private fun finish(endedNaturally: Boolean, byUser: Boolean) {
        accumulate()
        val track = current ?: return
        val listened = listenedMs
        val duration = durationMs
        current = null
        listenedMs = 0
        if (player.isPlaying) playingSince = SystemClock.elapsedRealtime()
        if (listened < MIN_RECORD_MS && !byUser) return
        val completed = endedNaturally || (duration > 0 && listened >= duration * 0.9)
        val skipped = byUser && !completed && (listened < SKIP_THRESHOLD_MS || (duration > 0 && listened < duration / 2))
        scope.launch { library.recordPlay(track, listened, duration, completed, skipped) }
    }

    companion object {
        private const val MIN_RECORD_MS = 5_000L
        private const val SKIP_THRESHOLD_MS = 30_000L
    }
}
