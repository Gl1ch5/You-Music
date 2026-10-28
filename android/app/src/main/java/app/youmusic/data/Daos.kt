package app.youmusic.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert

data class LikedTrackRow(
    @androidx.room.Embedded val track: TrackEntity,
    val likedAt: Long,
)

data class PlaylistRow(
    val id: Long,
    val name: String,
    val updatedAt: Long,
    val count: Int,
    val artwork: String?,
)

data class HistoryRow(
    @androidx.room.Embedded val track: TrackEntity,
    val playedAt: Long,
    val listenedMs: Long,
    val historyDurationMs: Long,
    val completed: Boolean,
    val skipped: Boolean,
)

@Dao
interface TrackDao {
    @Upsert
    suspend fun upsert(tracks: List<TrackEntity>)

    @Query("SELECT * FROM tracks WHERE id = :id")
    suspend fun get(id: String): TrackEntity?

    @Query("SELECT * FROM tracks WHERE id IN (:ids)")
    suspend fun getAll(ids: List<String>): List<TrackEntity>

    @Query("SELECT * FROM tracks WHERE source = 'local' ORDER BY addedAt DESC")
    suspend fun local(): List<TrackEntity>

    @Query("DELETE FROM tracks WHERE id = :id")
    suspend fun delete(id: String)
}

@Dao
interface LikeDao {
    @Query("SELECT tracks.*, likes.likedAt AS likedAt FROM likes JOIN tracks ON tracks.id = likes.trackId ORDER BY likes.likedAt DESC")
    suspend fun all(): List<LikedTrackRow>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(like: LikeEntity)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertAll(likes: List<LikeEntity>)

    @Query("DELETE FROM likes WHERE trackId = :trackId")
    suspend fun delete(trackId: String)
}

@Dao
interface PlaylistDao {
    @Query(
        """SELECT p.id, p.name, p.updatedAt,
           (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlistId = p.id) AS count,
           (SELECT t.artwork FROM playlist_tracks pt JOIN tracks t ON t.id = pt.trackId
              WHERE pt.playlistId = p.id ORDER BY pt.position LIMIT 1) AS artwork
           FROM playlists p ORDER BY p.updatedAt DESC""",
    )
    suspend fun summaries(): List<PlaylistRow>

    @Query("SELECT * FROM playlists WHERE id = :id")
    suspend fun get(id: Long): PlaylistEntity?

    @Insert
    suspend fun insert(playlist: PlaylistEntity): Long

    @Query("UPDATE playlists SET name = :name, updatedAt = :now WHERE id = :id")
    suspend fun rename(id: Long, name: String, now: Long)

    @Query("UPDATE playlists SET updatedAt = :now WHERE id = :id")
    suspend fun touch(id: Long, now: Long)

    @Query("DELETE FROM playlists WHERE id = :id")
    suspend fun delete(id: Long)

    @Query("SELECT t.* FROM playlist_tracks pt JOIN tracks t ON t.id = pt.trackId WHERE pt.playlistId = :id ORDER BY pt.position")
    suspend fun tracks(id: Long): List<TrackEntity>

    @Query("SELECT trackId FROM playlist_tracks WHERE playlistId = :id ORDER BY position")
    suspend fun trackIds(id: Long): List<String>

    @Query("DELETE FROM playlist_tracks WHERE playlistId = :id")
    suspend fun clearTracks(id: Long)

    @Insert
    suspend fun insertTracks(rows: List<PlaylistTrackEntity>)

    /** Positions are dense (0..n-1); every edit rewrites the list in one transaction. */
    @Transaction
    suspend fun replaceTracks(id: Long, trackIds: List<String>, now: Long) {
        clearTracks(id)
        insertTracks(trackIds.mapIndexed { i, t -> PlaylistTrackEntity(id, i, t) })
        touch(id, now)
    }
}

@Dao
interface HistoryDao {
    @Insert
    suspend fun insert(entry: HistoryEntity)

    @Query(
        """SELECT t.*, h.playedAt, h.listenedMs, h.durationMs AS historyDurationMs, h.completed, h.skipped
           FROM history h JOIN tracks t ON t.id = h.trackId ORDER BY h.playedAt DESC LIMIT :limit""",
    )
    suspend fun recent(limit: Int): List<HistoryRow>

    @Query("DELETE FROM history")
    suspend fun clear()

    @Query("SELECT * FROM history ORDER BY playedAt DESC LIMIT :limit")
    suspend fun entries(limit: Int): List<HistoryEntity>

    @Query("SELECT trackId || ':' || playedAt FROM history")
    suspend fun keys(): List<String>

    @Insert
    suspend fun insertAll(entries: List<HistoryEntity>)
}

@Dao
interface DownloadDao {
    @Query("SELECT * FROM downloads ORDER BY createdAt DESC")
    suspend fun all(): List<DownloadEntity>

    @Query("SELECT * FROM downloads WHERE trackId = :id")
    suspend fun get(id: String): DownloadEntity?

    @Upsert
    suspend fun upsert(entity: DownloadEntity)

    @Query("UPDATE downloads SET status = :status, progress = :progress, bytes = :bytes, error = :error WHERE trackId = :id")
    suspend fun updateProgress(id: String, status: String, progress: Float, bytes: Long, error: String?)

    @Query("DELETE FROM downloads WHERE trackId = :id")
    suspend fun delete(id: String)
}
