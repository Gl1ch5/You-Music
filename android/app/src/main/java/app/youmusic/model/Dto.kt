package app.youmusic.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** Track as seen by the UI. `id` is "yt:<videoId>" or "local:<hash>". Titles from YouTube are raw; the UI normalizes them. */
@Serializable
data class TrackDto(
    val id: String,
    val source: String,
    val title: String,
    val artist: String,
    val album: String? = null,
    val durationMs: Long = 0,
    val artwork: String? = null,
    val url: String? = null,
    val artistUrl: String? = null,
    val official: Boolean = false,
    val views: Long? = null,
)

@Serializable
data class CollectionDto(
    val kind: String,
    val id: String,
    val title: String,
    val subtitle: String? = null,
    val artwork: String? = null,
    val url: String,
    val count: Long? = null,
)

@Serializable
data class ArtistDto(
    val id: String,
    val name: String,
    val artwork: String? = null,
    val url: String,
    val subscribers: Long? = null,
)

@Serializable
data class SearchItemDto(
    val kind: String,
    val track: TrackDto? = null,
    val collection: CollectionDto? = null,
    val artist: ArtistDto? = null,
)

@Serializable
data class SearchPageDto(val items: List<SearchItemDto>, val nextPage: String? = null)

@Serializable
data class CollectionPageDto(val collection: CollectionDto, val tracks: List<TrackDto>)

@Serializable
data class ArtistPageDto(
    val artist: ArtistDto,
    val banner: String? = null,
    val tracks: List<TrackDto>,
    val albums: List<CollectionDto>,
)

@Serializable
data class TrackDetailsDto(val track: TrackDto, val related: List<TrackDto>)

@Serializable
data class PlaylistDto(
    val id: Long,
    val name: String,
    val count: Int,
    val artwork: String? = null,
    val updatedAt: Long,
)

@Serializable
data class PlaylistPageDto(val playlist: PlaylistDto, val tracks: List<TrackDto>)

@Serializable
data class LikeDto(val track: TrackDto, val likedAt: Long)

@Serializable
data class HistoryEntryDto(
    val track: TrackDto,
    val playedAt: Long,
    val listenedMs: Long,
    val durationMs: Long,
    val completed: Boolean,
    val skipped: Boolean,
)

@Serializable
data class DownloadDto(
    val trackId: String,
    val track: TrackDto? = null,
    val status: String,
    val progress: Float,
    val bytes: Long,
    val quality: String,
    val localArt: String? = null,
    val error: String? = null,
)

@Serializable
data class LibraryDto(
    val likes: List<LikeDto>,
    val playlists: List<PlaylistDto>,
    val downloads: List<DownloadDto>,
    val local: List<TrackDto>,
)

@Serializable
data class StorageDto(val downloadsBytes: Long, val cacheBytes: Long, val freeBytes: Long, val cacheLimitBytes: Long)

@Serializable
data class PlayerStateDto(
    val queue: List<TrackDto>,
    val index: Int,
    val playing: Boolean,
    val buffering: Boolean,
    val positionMs: Long,
    val durationMs: Long,
    val repeat: String,
    val shuffle: Boolean,
)

@Serializable
data class PaletteDto(val blurUrl: String?, val color: String?)

@Serializable
data class LyricsDto(val plain: String? = null, val synced: String? = null)

@Serializable
data class StagedModDto(val stageId: String, val manifest: JsonObject)

@Serializable
data class InstalledModDto(val id: String, val manifest: JsonObject, val baseUrl: String)

@Serializable
data class PickedTextDto(val name: String, val text: String)

@Serializable
data class InsetsDto(val top: Float, val bottom: Float, val left: Float, val right: Float)

@Serializable
data class HelloDto(
    val appVersion: String,
    val extractorVersion: String,
    val sdkInt: Int,
    val online: Boolean,
    val insets: InsetsDto,
)
