package app.youmusic.player

import android.app.PendingIntent
import android.content.Intent
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import app.youmusic.MainActivity
import app.youmusic.R
import app.youmusic.YouMusicApp
import app.youmusic.bridge.EventBus
import app.youmusic.source.toBridgeException
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.serialization.Serializable

@Serializable
data class PlayerErrorDto(val code: String, val message: String, val trackId: String?)

/** Owns the ExoPlayer: background playback, media notification, lock screen and headset buttons. */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null
    private lateinit var tracker: PlaybackHistoryTracker

    override fun onCreate() {
        super.onCreate()
        val graph = YouMusicApp.graph
        val player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(graph.playbackDataSource))
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
                true,
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()

        tracker = PlaybackHistoryTracker(player, graph.library, graph.appScope)
        player.addListener(object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                val mapped = (error.cause ?: error).toBridgeException()
                val current = player.currentMediaItem
                EventBus.emit("playerError", PlayerErrorDto(mapped.code, mapped.message ?: "Ошибка воспроизведения", current?.mediaId))
                // Skip an unplayable track instead of stopping the whole queue.
                if (player.hasNextMediaItem() && mapped.code != "offline") {
                    player.seekToNextMediaItem()
                    player.prepare()
                    player.play()
                }
            }
        })

        val openApp = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        session = MediaSession.Builder(this, player)
            .setSessionActivity(openApp)
            .setCallback(object : MediaSession.Callback {
                override fun onAddMediaItems(
                    mediaSession: MediaSession,
                    controller: MediaSession.ControllerInfo,
                    mediaItems: MutableList<MediaItem>,
                ): ListenableFuture<MutableList<MediaItem>> =
                    Futures.immediateFuture(mediaItems.map { it.withPlaybackUri() }.toMutableList())
            })
            .build()

        setMediaNotificationProvider(
            DefaultMediaNotificationProvider.Builder(this).build().apply { setSmallIcon(R.drawable.ic_notification) },
        )
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = session?.player
        if (player == null || !player.playWhenReady || player.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        tracker.flush()
        session?.run {
            player.release()
            release()
        }
        session = null
        super.onDestroy()
    }
}
