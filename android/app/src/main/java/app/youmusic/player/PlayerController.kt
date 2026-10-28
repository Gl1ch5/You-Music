package app.youmusic.player

import android.content.ComponentName
import android.content.Context
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import app.youmusic.bridge.EventBus
import app.youmusic.data.AppPaths
import app.youmusic.model.PlayerStateDto
import app.youmusic.model.TrackDto
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.guava.await
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

@Serializable
data class ProgressDto(val positionMs: Long, val durationMs: Long, val bufferedMs: Long)

@Serializable
data class TrackChangedDto(val track: TrackDto?, val index: Int)

@Serializable
data class QueueChangedDto(val queue: List<TrackDto>, val index: Int)

@Serializable
data class StateChangedDto(
    val playing: Boolean,
    val playWhenReady: Boolean,
    val buffering: Boolean,
    val repeat: String,
    val shuffle: Boolean,
    val ended: Boolean,
)

/** App-side handle to the playback session. All methods hop to the main thread, as Media3 requires. */
class PlayerController(
    private val context: Context,
    private val paths: AppPaths,
    private val scope: CoroutineScope,
) {
    private var controller: MediaController? = null
    private val connectLock = Mutex()
    private var ticker: Job? = null

    private suspend fun player(): MediaController = connectLock.withLock {
        controller?.takeIf { it.isConnected }?.let { return it }
        val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
        MediaController.Builder(context, token).buildAsync().await().also {
            controller = it
            it.addListener(listener)
        }
    }

    suspend fun <T> withPlayer(block: (MediaController) -> T): T = withContext(Dispatchers.Main) { block(player()) }

    suspend fun play(tracks: List<TrackDto>, index: Int, positionMs: Long) = withPlayer { p ->
        p.setMediaItems(tracks.map { it.toMediaItem(paths) }, index.coerceIn(0, (tracks.size - 1).coerceAtLeast(0)), positionMs)
        p.prepare()
        p.play()
    }

    suspend fun add(tracks: List<TrackDto>, next: Boolean) = withPlayer { p ->
        val items = tracks.map { it.toMediaItem(paths) }
        if (p.mediaItemCount == 0) {
            p.setMediaItems(items)
            p.prepare()
        } else if (next) {
            p.addMediaItems(p.currentMediaItemIndex + 1, items)
        } else {
            p.addMediaItems(items)
        }
    }

    suspend fun state(): PlayerStateDto = withPlayer { p ->
        PlayerStateDto(
            queue = p.queue(),
            index = p.currentMediaItemIndex,
            playing = p.isPlaying,
            buffering = p.playbackState == Player.STATE_BUFFERING,
            positionMs = p.currentPosition,
            durationMs = p.duration.coerceAtLeast(0),
            repeat = repeatName(p.repeatMode),
            shuffle = p.shuffleModeEnabled,
        )
    }

    private fun MediaController.queue(): List<TrackDto> =
        (0 until mediaItemCount).mapNotNull { getMediaItemAt(it).track() }

    private val listener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) {
            val p = player as MediaController
            if (events.contains(Player.EVENT_TIMELINE_CHANGED)) {
                EventBus.emit("queueChanged", QueueChangedDto(p.queue(), p.currentMediaItemIndex))
            }
            if (events.contains(Player.EVENT_MEDIA_ITEM_TRANSITION)) {
                EventBus.emit("trackChanged", TrackChangedDto(p.currentMediaItem?.track(), p.currentMediaItemIndex))
            }
            if (events.containsAny(
                    Player.EVENT_IS_PLAYING_CHANGED, Player.EVENT_PLAYBACK_STATE_CHANGED, Player.EVENT_PLAY_WHEN_READY_CHANGED,
                    Player.EVENT_REPEAT_MODE_CHANGED, Player.EVENT_SHUFFLE_MODE_ENABLED_CHANGED,
                )
            ) {
                EventBus.emit(
                    "stateChanged",
                    StateChangedDto(
                        playing = p.isPlaying,
                        playWhenReady = p.playWhenReady,
                        buffering = p.playbackState == Player.STATE_BUFFERING,
                        repeat = repeatName(p.repeatMode),
                        shuffle = p.shuffleModeEnabled,
                        ended = p.playbackState == Player.STATE_ENDED,
                    ),
                )
                emitProgress(p)
            }
            if (events.contains(Player.EVENT_POSITION_DISCONTINUITY)) emitProgress(p)
            if (p.isPlaying) startTicker() else stopTicker()
        }
    }

    private fun emitProgress(p: Player) {
        EventBus.emit("progress", ProgressDto(p.currentPosition, p.duration.coerceAtLeast(0), p.bufferedPosition))
    }

    private fun startTicker() {
        if (ticker?.isActive == true) return
        ticker = scope.launch(Dispatchers.Main) {
            while (isActive) {
                controller?.let(::emitProgress)
                delay(500)
            }
        }
    }

    private fun stopTicker() {
        ticker?.cancel()
        ticker = null
    }

    companion object {
        fun repeatName(mode: Int) = when (mode) {
            Player.REPEAT_MODE_ONE -> "one"
            Player.REPEAT_MODE_ALL -> "all"
            else -> "off"
        }

        fun repeatMode(name: String) = when (name) {
            "one" -> Player.REPEAT_MODE_ONE
            "all" -> Player.REPEAT_MODE_ALL
            else -> Player.REPEAT_MODE_OFF
        }
    }
}
