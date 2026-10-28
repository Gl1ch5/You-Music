package app.youmusic.data

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import app.youmusic.model.TrackDto

@Entity(tableName = "tracks", indices = [Index("source")])
data class TrackEntity(
    @PrimaryKey val id: String,
    val source: String,
    val title: String,
    val artist: String,
    val album: String?,
    val durationMs: Long,
    val artwork: String?,
    val url: String?,
    val artistUrl: String?,
    val official: Boolean,
    val addedAt: Long = System.currentTimeMillis(),
) {
    fun toDto() = TrackDto(id, source, title, artist, album, durationMs, artwork, url, artistUrl, official)

    companion object {
        fun from(t: TrackDto) = TrackEntity(t.id, t.source, t.title, t.artist, t.album, t.durationMs, t.artwork, t.url, t.artistUrl, t.official)
    }
}

@Entity(tableName = "likes")
data class LikeEntity(@PrimaryKey val trackId: String, val likedAt: Long)

@Entity(tableName = "playlists")
data class PlaylistEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val name: String,
    val createdAt: Long,
    val updatedAt: Long,
)

@Entity(tableName = "playlist_tracks", primaryKeys = ["playlistId", "position"], indices = [Index("trackId")])
data class PlaylistTrackEntity(val playlistId: Long, val position: Int, val trackId: String)

@Entity(tableName = "history", indices = [Index("trackId"), Index("playedAt")])
data class HistoryEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val trackId: String,
    val playedAt: Long,
    val listenedMs: Long,
    val durationMs: Long,
    val completed: Boolean,
    val skipped: Boolean,
)

@Entity(tableName = "downloads")
data class DownloadEntity(
    @PrimaryKey val trackId: String,
    val status: String,
    val progress: Float,
    val bytes: Long,
    val quality: String,
    val filePath: String?,
    val artPath: String?,
    val error: String?,
    val createdAt: Long,
)

object DownloadStatus {
    const val QUEUED = "queued"
    const val RUNNING = "running"
    const val DONE = "done"
    const val FAILED = "failed"
}
