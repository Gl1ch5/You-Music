package app.youmusic

import android.app.Application
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import app.youmusic.art.ArtworkProcessor
import app.youmusic.data.AppDatabase
import app.youmusic.data.AppPaths
import app.youmusic.data.KeyValueStore
import app.youmusic.data.LibraryRepository
import app.youmusic.download.DownloadRepository
import app.youmusic.local.LocalMediaImporter
import app.youmusic.mods.ModStore
import app.youmusic.net.NetworkMonitor
import app.youmusic.player.PlaybackDataSourceFactory
import app.youmusic.player.PlayerController
import app.youmusic.source.ImportRepository
import app.youmusic.source.LyricsRepository
import app.youmusic.source.NewPipeHttp
import app.youmusic.source.StreamResolver
import app.youmusic.source.YouTubeRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.services.youtube.YoutubeJavaScriptPlayerManager
import org.schabi.newpipe.extractor.localization.ContentCountry
import org.schabi.newpipe.extractor.localization.Localization
import java.util.Locale

/** Hand-wired dependency graph. Adding a native feature = add a field here + a BridgeModule. */
@OptIn(UnstableApi::class)
class AppGraph(app: Application) {
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val paths = AppPaths(app)
    val kv = KeyValueStore(app)
    val db = AppDatabase.create(app)
    val network = NetworkMonitor(app)
    val youtube = YouTubeRepository()
    val resolver = StreamResolver(youtube, kv)
    val library = LibraryRepository(db)
    val downloads = DownloadRepository(app, db, paths, resolver, library, kv)
    val local = LocalMediaImporter(app, library, paths)
    val mods = ModStore(app, paths)
    val artwork = ArtworkProcessor(paths)
    val lyrics = LyricsRepository()
    val importer = ImportRepository()
    val mediaCache = SimpleCache(
        paths.media,
        LeastRecentlyUsedCacheEvictor(kv.settings.cacheLimitMb.coerceIn(64, 8192).toLong() shl 20),
        StandaloneDatabaseProvider(app),
    )
    val playbackDataSource = PlaybackDataSourceFactory(app, mediaCache, resolver, downloads, network)
    val player = PlayerController(app, paths, appScope)
}

class YouMusicApp : Application() {
    override fun onCreate() {
        super.onCreate()
        val locale = Locale.getDefault()
        NewPipe.init(NewPipeHttp, Localization(locale.language, locale.country.ifEmpty { null }), ContentCountry(locale.country.ifEmpty { "US" }))
        graph = AppGraph(this)
        graph.appScope.launch { graph.downloads.init() }
        // Fetch YouTube's player script once up front so the first tap on a track doesn't pay for it.
        graph.appScope.launch {
            if (graph.network.online) runCatching { YoutubeJavaScriptPlayerManager.getSignatureTimestamp(WARMUP_VIDEO_ID) }
        }
    }

    companion object {
        private const val WARMUP_VIDEO_ID = "dQw4w9WgXcQ"

        lateinit var graph: AppGraph
            private set
    }
}
