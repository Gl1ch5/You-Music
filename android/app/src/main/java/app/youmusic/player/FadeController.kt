package app.youmusic.player

import androidx.media3.common.Player
import app.youmusic.data.KeyValueStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Smooth transitions: fades the volume out over the last N seconds of a track and back in at the start
 * of the next one. N comes from settings (`crossfadeSec`, 0 = off).
 */
class FadeController(private val player: Player, private val kv: KeyValueStore, scope: CoroutineScope) {
    private var fadeMs = 0L
    private var settingsReadAt = 0L

    private val job = scope.launch(Dispatchers.Main) {
        while (isActive) {
            tick()
            delay(80)
        }
    }

    fun stop() = job.cancel()

    private fun tick() {
        val now = System.currentTimeMillis()
        if (now - settingsReadAt > 3000) {
            fadeMs = kv.settings.crossfadeSec.coerceIn(0, 12) * 1000L
            settingsReadAt = now
        }
        if (fadeMs == 0L || !player.isPlaying) {
            if (player.volume != 1f && fadeMs == 0L) player.volume = 1f
            return
        }
        val duration = player.duration
        val pos = player.currentPosition
        val fadeIn = fadeMs / 2
        val target = when {
            duration > fadeMs * 3 && duration - pos < fadeMs && player.hasNextMediaItem() -> ((duration - pos).toFloat() / fadeMs)
            pos < fadeIn -> pos.toFloat() / fadeIn
            else -> 1f
        }.coerceIn(0.05f, 1f)
        if (kotlin.math.abs(player.volume - target) > 0.01f) player.volume = target
    }
}
