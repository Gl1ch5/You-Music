package app.youmusic.data

import androidx.room.withTransaction
import app.youmusic.bridge.BridgeException
import app.youmusic.bridge.BridgeJson
import app.youmusic.bridge.EventBus
import app.youmusic.model.HistoryEntryDto
import app.youmusic.model.LikeDto
import app.youmusic.model.PlaylistDto
import app.youmusic.model.PlaylistPageDto
import app.youmusic.model.TrackDto
import kotlinx.serialization.Serializable

@Serializable
data class LibraryChangedDto(val what: String)

@Serializable
data class LibraryExport(
    val format: String = "you-music-library",
    val version: Int = 2,
    val exportedAt: Long,
    val tracks: List<TrackDto>,
    val likes: List<ExportLike>,
    val playlists: List<ExportPlaylist>,
    /** Since version 2 (full backup): listening history and UI/native settings. */
    val history: List<ExportHistory> = emptyList(),
    val settings: Map<String, String> = emptyMap(),
)

@Serializable
data class ExportLike(val trackId: String, val likedAt: Long)

@Serializable
data class ExportPlaylist(val name: String, val trackIds: List<String>)

@Serializable
data class ExportHistory(val trackId: String, val playedAt: Long, val listenedMs: Long, val durationMs: Long, val completed: Boolean, val skipped: Boolean)

class LibraryRepository(private val db: AppDatabase) {

    suspend fun likes(): List<LikeDto> = db.likes().all().map { LikeDto(it.track.toDto(), it.likedAt) }

    suspend fun setLiked(track: TrackDto, liked: Boolean) {
        if (liked) {
            db.tracks().upsert(listOf(TrackEntity.from(track)))
            db.likes().insert(LikeEntity(track.id, System.currentTimeMillis()))
        } else {
            db.likes().delete(track.id)
        }
        changed("likes")
    }

    suspend fun playlists(): List<PlaylistDto> = db.playlists().summaries().map {
        PlaylistDto(it.id, it.name, it.count, it.artwork, it.updatedAt)
    }

    suspend fun createPlaylist(name: String, tracks: List<TrackDto>): PlaylistDto {
        val now = System.currentTimeMillis()
        val id = db.withTransaction {
            val id = db.playlists().insert(PlaylistEntity(name = name.trim().ifEmpty { "Новый плейлист" }, createdAt = now, updatedAt = now))
            if (tracks.isNotEmpty()) {
                db.tracks().upsert(tracks.map(TrackEntity::from))
                db.playlists().replaceTracks(id, tracks.map { it.id }.distinct(), now)
            }
            id
        }
        changed("playlists")
        return playlists().first { it.id == id }
    }

    suspend fun renamePlaylist(id: Long, name: String) {
        db.playlists().rename(id, name.trim(), System.currentTimeMillis())
        changed("playlists")
    }

    suspend fun deletePlaylist(id: Long) {
        db.withTransaction {
            db.playlists().clearTracks(id)
            db.playlists().delete(id)
        }
        changed("playlists")
    }

    suspend fun playlist(id: Long): PlaylistPageDto {
        val summary = playlists().firstOrNull { it.id == id } ?: throw BridgeException("not_found", "Плейлист не найден")
        return PlaylistPageDto(summary, db.playlists().tracks(id).map { it.toDto() })
    }

    suspend fun addToPlaylist(id: Long, tracks: List<TrackDto>) = editPlaylist(id) { ids ->
        db.tracks().upsert(tracks.map(TrackEntity::from))
        ids + tracks.map { it.id }.filter { it !in ids }
    }

    suspend fun removeFromPlaylist(id: Long, index: Int) = editPlaylist(id) { ids ->
        ids.filterIndexed { i, _ -> i != index }
    }

    suspend fun movePlaylistTrack(id: Long, from: Int, to: Int) = editPlaylist(id) { ids ->
        if (from !in ids.indices || to !in ids.indices) ids
        else ids.toMutableList().apply { add(to, removeAt(from)) }
    }

    private suspend fun editPlaylist(id: Long, edit: suspend (List<String>) -> List<String>) {
        db.withTransaction {
            db.playlists().get(id) ?: throw BridgeException("not_found", "Плейлист не найден")
            val next = edit(db.playlists().trackIds(id))
            db.playlists().replaceTracks(id, next, System.currentTimeMillis())
        }
        changed("playlists")
    }

    suspend fun recordPlay(track: TrackDto, listenedMs: Long, durationMs: Long, completed: Boolean, skipped: Boolean) {
        db.tracks().upsert(listOf(TrackEntity.from(track)))
        db.history().insert(HistoryEntity(0, track.id, System.currentTimeMillis(), listenedMs, durationMs, completed, skipped))
        changed("history")
    }

    suspend fun history(limit: Int): List<HistoryEntryDto> = db.history().recent(limit.coerceIn(1, 2000)).map {
        HistoryEntryDto(it.track.toDto(), it.playedAt, it.listenedMs, it.historyDurationMs, it.completed, it.skipped)
    }

    suspend fun clearHistory() {
        db.history().clear()
        changed("history")
    }

    suspend fun upsertTracks(tracks: List<TrackDto>) = db.tracks().upsert(tracks.map(TrackEntity::from))

    suspend fun track(id: String): TrackDto? = db.tracks().get(id)?.toDto()

    suspend fun localTracks(): List<TrackDto> = db.tracks().local().map { it.toDto() }

    suspend fun deleteTrack(id: String) {
        db.likes().delete(id)
        db.tracks().delete(id)
    }

    suspend fun export(): String = BridgeJson.encodeToString(LibraryExport.serializer(), exportData(withHistory = false))

    /** Likes, playlists and (optionally) history with the tracks they reference. Local files are skipped: their URIs die with the app. */
    suspend fun exportData(withHistory: Boolean): LibraryExport {
        val likes = db.likes().all()
        val playlists = db.playlists().summaries().map { ExportPlaylist(it.name, db.playlists().trackIds(it.id)) }
        val history = if (withHistory) db.history().entries(HISTORY_LIMIT) else emptyList()
        val ids = (likes.map { it.track.id } + playlists.flatMap { it.trackIds } + history.map { it.trackId }).distinct()
        val tracks = ids.chunked(500).flatMap { db.tracks().getAll(it) }.map { it.toDto() }.filter { it.source != "local" }
        val known = tracks.map { it.id }.toHashSet()
        return LibraryExport(
            exportedAt = System.currentTimeMillis(),
            tracks = tracks,
            likes = likes.filter { it.track.id in known }.map { ExportLike(it.track.id, it.likedAt) },
            playlists = playlists,
            history = history.filter { it.trackId in known }.map { ExportHistory(it.trackId, it.playedAt, it.listenedMs, it.durationMs, it.completed, it.skipped) },
        )
    }

    suspend fun import(json: String): Int = importData(parse(json))

    /**
     * Merges an export into the library: likes and history are added (no duplicates),
     * a playlist with the same name is replaced instead of being duplicated.
     */
    /** With [merge] (cloud sync), playlists keep their local tracks and gain the incoming ones. */
    suspend fun importData(data: LibraryExport, merge: Boolean = false): Int {
        val known = data.tracks.map { it.id }.toHashSet()
        db.withTransaction {
            db.tracks().upsert(data.tracks.map(TrackEntity::from))
            db.likes().insertAll(data.likes.filter { it.trackId in known }.map { LikeEntity(it.trackId, it.likedAt) })
            val now = System.currentTimeMillis()
            val existing = db.playlists().summaries().groupBy { it.name }
            data.playlists.forEach { p ->
                val id = existing[p.name]?.firstOrNull()?.id
                    ?: db.playlists().insert(PlaylistEntity(name = p.name, createdAt = now, updatedAt = now))
                val incoming = p.trackIds.filter { it in known }
                val ids = if (merge) db.playlists().trackIds(id) + incoming else incoming
                db.playlists().replaceTracks(id, ids.distinct(), now)
            }
            if (data.history.isNotEmpty()) {
                val seen = db.history().keys().toHashSet()
                db.history().insertAll(
                    data.history.filter { it.trackId in known && "${it.trackId}:${it.playedAt}" !in seen }
                        .map { HistoryEntity(trackId = it.trackId, playedAt = it.playedAt, listenedMs = it.listenedMs, durationMs = it.durationMs, completed = it.completed, skipped = it.skipped) },
                )
            }
        }
        changed("all")
        return data.tracks.size
    }

    fun parse(json: String): LibraryExport {
        val data = runCatching { BridgeJson.decodeFromString(LibraryExport.serializer(), json) }
            .getOrElse { throw BridgeException("bad_request", "Файл не похож на экспорт библиотеки") }
        if (data.format != "you-music-library") throw BridgeException("bad_request", "Неизвестный формат файла")
        return data
    }

    private fun changed(what: String) {
        EventBus.emit("libraryChanged", LibraryChangedDto(what))
        if (what != "history") onChanged?.invoke()
    }

    /** Called after likes/playlists change (the auto backup listens). */
    var onChanged: (() -> Unit)? = null

    companion object {
        private const val HISTORY_LIMIT = 5000
    }
}
