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
    val version: Int = 1,
    val exportedAt: Long,
    val tracks: List<TrackDto>,
    val likes: List<ExportLike>,
    val playlists: List<ExportPlaylist>,
)

@Serializable
data class ExportLike(val trackId: String, val likedAt: Long)

@Serializable
data class ExportPlaylist(val name: String, val trackIds: List<String>)

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

    suspend fun export(): String {
        val likes = db.likes().all()
        val playlists = db.playlists().summaries().map { ExportPlaylist(it.name, db.playlists().trackIds(it.id)) }
        val ids = (likes.map { it.track.id } + playlists.flatMap { it.trackIds }).distinct()
        val tracks = ids.chunked(500).flatMap { db.tracks().getAll(it) }.map { it.toDto() }
        val export = LibraryExport(
            exportedAt = System.currentTimeMillis(),
            tracks = tracks.filter { it.source != "local" },
            likes = likes.filter { it.track.source != "local" }.map { ExportLike(it.track.id, it.likedAt) },
            playlists = playlists,
        )
        return BridgeJson.encodeToString(LibraryExport.serializer(), export)
    }

    /** Merges an export into the library: likes are added, playlists are appended as new ones. */
    suspend fun import(json: String): Int {
        val data = runCatching { BridgeJson.decodeFromString(LibraryExport.serializer(), json) }
            .getOrElse { throw BridgeException("bad_request", "Файл не похож на экспорт библиотеки") }
        if (data.format != "you-music-library") throw BridgeException("bad_request", "Неизвестный формат файла")
        val known = data.tracks.map { it.id }.toHashSet()
        db.withTransaction {
            db.tracks().upsert(data.tracks.map(TrackEntity::from))
            db.likes().insertAll(data.likes.filter { it.trackId in known }.map { LikeEntity(it.trackId, it.likedAt) })
            val now = System.currentTimeMillis()
            data.playlists.forEach { p ->
                val id = db.playlists().insert(PlaylistEntity(name = p.name, createdAt = now, updatedAt = now))
                db.playlists().replaceTracks(id, p.trackIds.filter { it in known }.distinct(), now)
            }
        }
        changed("all")
        return data.tracks.size
    }

    private fun changed(what: String) = EventBus.emit("libraryChanged", LibraryChangedDto(what))
}
