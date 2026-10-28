package app.youmusic.bridge.modules

import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.cache.SimpleCache
import app.youmusic.bridge.BridgeModule
import app.youmusic.bridge.CommandRegistry
import app.youmusic.bridge.NoArgs
import app.youmusic.data.AppPaths
import app.youmusic.data.KeyValueStore
import app.youmusic.download.DownloadRepository
import app.youmusic.local.LocalMediaImporter
import app.youmusic.model.DownloadDto
import app.youmusic.model.StorageDto
import app.youmusic.model.TrackDto
import app.youmusic.system.ActivityHost
import kotlinx.serialization.Serializable

@Serializable data class DownloadArgs(val tracks: List<TrackDto>, val quality: String? = null)
@Serializable data class TrackIdArgs(val id: String)
@Serializable data class LocalImportArgs(val mode: String = "files")

/** Downloads, stream cache and the user's own audio files. */
@OptIn(UnstableApi::class)
class OfflineModule(
    private val downloads: DownloadRepository,
    private val local: LocalMediaImporter,
    private val cache: SimpleCache,
    private val paths: AppPaths,
    private val kv: KeyValueStore,
    private val host: ActivityHost,
) : BridgeModule {
    override fun register(registry: CommandRegistry) = with(registry) {
        command<DownloadArgs, Unit>("download") { downloads.enqueue(it.tracks, it.quality) }
        command<TrackIdArgs, Unit>("downloadRemove") { downloads.remove(it.id) }
        command<NoArgs, List<DownloadDto>>("downloads") { downloads.list() }
        command<NoArgs, StorageDto>("storageInfo") {
            StorageDto(downloads.totalBytes(), cache.cacheSpace, paths.downloads.usableSpace, kv.settings.cacheLimitMb.toLong() shl 20)
        }
        command<NoArgs, Unit>("clearCache") {
            cache.keys.toList().forEach { cache.removeResource(it) }
            paths.blur.listFiles()?.forEach { it.delete() }
        }
        command<LocalImportArgs, List<TrackDto>>("localImport") { a ->
            if (a.mode == "folder") host.pickTree()?.let { local.importTree(it) }.orEmpty()
            else local.importFiles(host.pickDocuments(arrayOf("audio/*"), multiple = true))
        }
        command<TrackIdArgs, Unit>("localRemove") { local.remove(it.id) }
    }
}
