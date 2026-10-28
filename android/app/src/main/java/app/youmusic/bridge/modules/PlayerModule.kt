package app.youmusic.bridge.modules

import app.youmusic.bridge.BridgeModule
import app.youmusic.bridge.CommandRegistry
import app.youmusic.bridge.NoArgs
import app.youmusic.model.PlayerStateDto
import app.youmusic.model.TrackDto
import app.youmusic.player.PlayerController
import kotlinx.serialization.Serializable

@Serializable data class PlayArgs(val queue: List<TrackDto>, val index: Int = 0, val positionMs: Long = 0)
@Serializable data class SeekArgs(val positionMs: Double)
@Serializable data class IndexArgs(val index: Int)
@Serializable data class MoveArgs(val from: Int, val to: Int)
@Serializable data class QueueAddArgs(val tracks: List<TrackDto>, val next: Boolean = false)
@Serializable data class QueueReplaceArgs(val tracks: List<TrackDto> = emptyList())
@Serializable data class TrackArgs(val track: TrackDto)
@Serializable data class RepeatArgs(val mode: String)
@Serializable data class ShuffleArgs(val enabled: Boolean)

class PlayerModule(private val player: PlayerController, private val info: app.youmusic.player.TrackInfoReader) : BridgeModule {
    override fun register(registry: CommandRegistry) = with(registry) {
        command<PlayArgs, Unit>("play") { player.play(it.queue, it.index, it.positionMs) }
        command<NoArgs, Unit>("pause") { player.withPlayer { p -> p.pause() } }
        command<NoArgs, Unit>("resume") {
            player.withPlayer { p ->
                if (p.playbackState == androidx.media3.common.Player.STATE_IDLE) p.prepare()
                if (p.playbackState == androidx.media3.common.Player.STATE_ENDED) p.seekToDefaultPosition()
                p.play()
            }
        }
        command<SeekArgs, Unit>("seek") { a -> player.withPlayer { p -> p.seekTo(a.positionMs.toLong().coerceAtLeast(0)) } }
        command<NoArgs, Unit>("next") { player.withPlayer { p -> if (p.hasNextMediaItem()) p.seekToNextMediaItem() } }
        command<NoArgs, Unit>("previous") {
            player.withPlayer { p ->
                if (p.currentPosition > 3000 || !p.hasPreviousMediaItem()) p.seekTo(0) else p.seekToPreviousMediaItem()
            }
        }
        command<IndexArgs, Unit>("skipTo") { a -> player.withPlayer { p -> if (a.index in 0 until p.mediaItemCount) { p.seekTo(a.index, 0); p.play() } } }
        command<QueueAddArgs, Unit>("queueAdd") { player.add(it.tracks, it.next) }
        command<QueueReplaceArgs, Unit>("queueReplaceUpcoming") { player.replaceUpcoming(it.tracks) }
        command<IndexArgs, Unit>("queueRemove") { a -> player.withPlayer { p -> if (a.index in 0 until p.mediaItemCount) p.removeMediaItem(a.index) } }
        command<MoveArgs, Unit>("queueMove") { a ->
            player.withPlayer { p -> if (a.from in 0 until p.mediaItemCount && a.to in 0 until p.mediaItemCount) p.moveMediaItem(a.from, a.to) }
        }
        command<NoArgs, Unit>("queueClear") { player.withPlayer { p -> p.clearMediaItems() } }
        command<RepeatArgs, Unit>("setRepeat") { a -> player.withPlayer { p -> p.repeatMode = PlayerController.repeatMode(a.mode) } }
        command<ShuffleArgs, Unit>("setShuffle") { a -> player.withPlayer { p -> p.shuffleModeEnabled = a.enabled } }
        command<NoArgs, PlayerStateDto>("getPlayerState") { player.state() }
        command<TrackArgs, app.youmusic.player.TrackInfoDto>("trackInfo") { info.info(it.track) }
    }
}
