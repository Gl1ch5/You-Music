package app.youmusic.player

import android.content.Context
import android.net.Uri
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.datasource.TransferListener
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.datasource.okhttp.OkHttpDataSource
import app.youmusic.download.DownloadRepository
import app.youmusic.net.Http
import app.youmusic.net.NetworkMonitor
import app.youmusic.source.OfflineException
import app.youmusic.source.StreamResolveException
import app.youmusic.source.StreamResolver

/**
 * Where audio bytes come from, in order: downloaded file → stream cache → YouTube (resolved lazily, read in chunks).
 * Local files and content:// uris bypass the cache entirely.
 */
@UnstableApi
class PlaybackDataSourceFactory(
    context: Context,
    cache: SimpleCache,
    private val resolver: StreamResolver,
    private val downloads: DownloadRepository,
    private val network: NetworkMonitor,
) : DataSource.Factory {

    private val local = DefaultDataSource.Factory(context)

    private val remote: DataSource.Factory = CacheDataSource.Factory()
        .setCache(cache)
        .setCacheKeyFactory { spec -> spec.key ?: spec.uri.toString() }
        .setUpstreamDataSourceFactory {
            ChunkedDataSource(
                ResolvingDataSource.Factory(OkHttpDataSource.Factory(Http.callFactory)) { spec -> resolve(spec) }.createDataSource(),
                onForbidden = { uri -> uri.lastPathSegment?.let(resolver::invalidate) },
            )
        }
        .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)

    private fun resolve(spec: DataSpec): DataSpec {
        if (spec.uri.scheme != YM_SCHEME) return spec
        if (!network.online) throw OfflineException()
        val videoId = spec.uri.lastPathSegment ?: return spec
        val stream = try {
            resolver.resolveOrAlternative(videoId, spec.uri.getQueryParameter("q"), spec.uri.getQueryParameter("d")?.toLongOrNull() ?: 0)
        } catch (e: java.io.IOException) {
            throw e
        } catch (e: Exception) {
            throw StreamResolveException(e)
        }
        return spec.withUri(Uri.parse(stream.url)).withAdditionalHeaders(mapOf("User-Agent" to stream.userAgent))
    }

    override fun createDataSource(): DataSource = RoutingDataSource(local.createDataSource(), remote.createDataSource(), downloads)
}

@UnstableApi
private class RoutingDataSource(
    private val local: DataSource,
    private val remote: DataSource,
    private val downloads: DownloadRepository,
) : DataSource {
    private var active: DataSource? = null

    override fun addTransferListener(transferListener: TransferListener) {
        local.addTransferListener(transferListener)
        remote.addTransferListener(transferListener)
    }

    override fun open(dataSpec: DataSpec): Long {
        if (dataSpec.uri.scheme == YM_SCHEME) {
            val file = dataSpec.uri.lastPathSegment?.let { downloads.localFile("yt:$it") }
            if (file != null) {
                active = local
                return local.open(dataSpec.withUri(Uri.fromFile(file)))
            }
            active = remote
            return remote.open(dataSpec)
        }
        active = local
        return local.open(dataSpec)
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int = active!!.read(buffer, offset, length)

    override fun getUri(): Uri? = active?.uri

    override fun getResponseHeaders(): Map<String, List<String>> = active?.responseHeaders ?: emptyMap()

    override fun close() {
        try {
            active?.close()
        } finally {
            active = null
        }
    }
}
