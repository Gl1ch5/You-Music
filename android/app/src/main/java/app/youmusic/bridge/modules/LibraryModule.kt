package app.youmusic.bridge.modules

import app.youmusic.bridge.BridgeModule
import app.youmusic.bridge.CommandRegistry
import app.youmusic.bridge.NoArgs
import app.youmusic.data.LibraryRepository
import app.youmusic.download.DownloadRepository
import app.youmusic.model.HistoryEntryDto
import app.youmusic.model.LibraryDto
import app.youmusic.model.PlaylistDto
import app.youmusic.model.PlaylistPageDto
import app.youmusic.model.TrackDto
import kotlinx.serialization.Serializable

@Serializable data class LikeArgs(val track: TrackDto, val liked: Boolean)
@Serializable data class PlaylistCreateArgs(val name: String, val tracks: List<TrackDto> = emptyList())
@Serializable data class PlaylistIdArgs(val id: Long)
@Serializable data class PlaylistRenameArgs(val id: Long, val name: String)
@Serializable data class PlaylistTracksArgs(val id: Long, val tracks: List<TrackDto>)
@Serializable data class PlaylistIndexArgs(val id: Long, val index: Int)
@Serializable data class PlaylistMoveArgs(val id: Long, val from: Int, val to: Int)
@Serializable data class LimitArgs(val limit: Int = 200)
@Serializable data class JsonTextArgs(val json: String)

class LibraryModule(private val library: LibraryRepository, private val downloads: DownloadRepository) : BridgeModule {
    override fun register(registry: CommandRegistry) = with(registry) {
        command<NoArgs, LibraryDto>("getLibrary") {
            LibraryDto(library.likes(), library.playlists(), downloads.list(), library.localTracks())
        }
        command<LikeArgs, Unit>("like") { library.setLiked(it.track, it.liked) }
        command<PlaylistCreateArgs, PlaylistDto>("playlistCreate") { library.createPlaylist(it.name, it.tracks) }
        command<PlaylistRenameArgs, Unit>("playlistRename") { library.renamePlaylist(it.id, it.name) }
        command<PlaylistIdArgs, Unit>("playlistDelete") { library.deletePlaylist(it.id) }
        command<PlaylistIdArgs, PlaylistPageDto>("playlistGet") { library.playlist(it.id) }
        command<PlaylistTracksArgs, Unit>("playlistAdd") { library.addToPlaylist(it.id, it.tracks) }
        command<PlaylistIndexArgs, Unit>("playlistRemove") { library.removeFromPlaylist(it.id, it.index) }
        command<PlaylistMoveArgs, Unit>("playlistMove") { library.movePlaylistTrack(it.id, it.from, it.to) }
        command<LimitArgs, List<HistoryEntryDto>>("history") { library.history(it.limit) }
        command<NoArgs, Unit>("historyClear") { library.clearHistory() }
        command<NoArgs, String>("libraryExport") { library.export() }
        command<JsonTextArgs, Int>("libraryImport") { library.import(it.json) }
    }
}
