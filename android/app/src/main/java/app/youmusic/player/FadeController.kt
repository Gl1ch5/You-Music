package app.youmusic.player

import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import app.youmusic.data.KeyValueStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.PI
import kotlin.math.sin

/**
 * Smooth transitions: fades the volume out over the last N seconds of a track and back in at the start
 * of the next one. N comes from settings (`crossfadeSec`, 0 = off).
 *
 * The curve is equal-power (sine), and the volume never moves faster than [MAX_STEP_PER_MS], so a seek into the
 * tail, a skip or an unknown duration never makes the sound jump. Tracks the user switched to by hand get only
 * a short fade-in: the long one is for automatic transitions.
 */
class FadeController(private val player: Player, private val kv: KeyValueStore, scope: CoroutineScope) {
    private var fadeMs = 0L
    private var settingsReadAt = 0L
    private var fadeInMs = 0L
    private var lastTickAt = 0L

    private val listener = object : Player.Listener {
        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            fadeInMs = if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) fadeMs / 2 else MANUAL_FADE_IN_MS
        }
    }

    private val job = scope.launch(Dispatchers.Main) {
        player.addListener(listener)
        while (isActive) {
            tick()
            delay(TICK_MS)
        }
    }

    fun stop() {
        job.cancel()
        player.removeListener(listener)
    }

    private fun tick() {
        val now = System.currentTimeMillis()
        val elapsed = (now - lastTickAt).coerceIn(1, 500)
        lastTickAt = now
        if (now - settingsReadAt > 3000) {
            fadeMs = kv.settings.crossfadeSec.coerceIn(0, 12) * 1000L
            settingsReadAt = now
        }
        if (fadeMs == 0L) {
            if (player.volume != 1f) player.volume = 1f
            return
        }
        if (!player.isPlaying) return
        val duration = player.duration
        val pos = player.currentPosition
        val left = if (duration == C.TIME_UNSET) Long.MAX_VALUE else duration - pos
        val out = if (duration != C.TIME_UNSET && duration > fadeMs * 3 && left < fadeMs && player.hasNextMediaItem()) curve(left.toFloat() / fadeMs) else 1f
        val inn = if (fadeInMs > 0 && pos < fadeInMs) curve(pos.toFloat() / fadeInMs) else 1f
        val target = minOf(out, inn).coerceIn(0f, 1f)
        val current = player.volume
        val step = MAX_STEP_PER_MS * elapsed
        val next = if (target > current) minOf(target, current + step) else maxOf(target, current - step)
        if (kotlin.math.abs(current - next) > 0.002f) player.volume = next
    }

    /** Equal-power: the sum of two overlapping fades stays at the same loudness; ends at true silence. */
    private fun curve(x: Float): Float = sin(x.coerceIn(0f, 1f) * PI / 2).toFloat()

    companion object {
        private const val TICK_MS = 40L
        private const val MANUAL_FADE_IN_MS = 350L
        /** Full range in no less than ~250 ms. */
        private const val MAX_STEP_PER_MS = 1f / 250f
    }
}
