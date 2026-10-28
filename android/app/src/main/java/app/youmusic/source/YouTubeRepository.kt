package app.youmusic.source

import android.util.LruCache
import app.youmusic.bridge.BridgeException
import app.youmusic.model.ArtistDto
import app.youmusic.model.ArtistPageDto
import app.youmusic.model.CollectionDto
import app.youmusic.model.CollectionPageDto
import app.youmusic.model.SearchItemDto
import app.youmusic.model.SearchPageDto
import app.youmusic.model.TrackDetailsDto
import app.youmusic.model.TrackDto
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import org.schabi.newpipe.extractor.Image
import org.schabi.newpipe.extractor.InfoItem
import org.schabi.newpipe.extractor.Page
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.channel.ChannelInfo
import org.schabi.newpipe.extractor.channel.ChannelInfoItem
import org.schabi.newpipe.extractor.channel.tabs.ChannelTabInfo
import org.schabi.newpipe.extractor.channel.tabs.ChannelTabs
import org.schabi.newpipe.extractor.linkhandler.SearchQueryHandler
import org.schabi.newpipe.extractor.playlist.PlaylistInfo
import org.schabi.newpipe.extractor.playlist.PlaylistInfoItem
import org.schabi.newpipe.extractor.search.SearchInfo
import org.schabi.newpipe.extractor.services.youtube.linkHandler.YoutubeSearchQueryHandlerFactory as Filters
import org.schabi.newpipe.extractor.stream.StreamInfo
import org.schabi.newpipe.extractor.stream.StreamInfoItem
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Everything YouTube: search, suggestions, collections, artists, stream metadata.
 * Results are raw (titles as uploaded); normalization and ranking happen in the UI.
 */
class YouTubeRepository {
    private val yt get() = ServiceList.YouTube
    private val pages = ConcurrentHashMap<String, Pair<SearchQueryHandler, Page>>()
    private val streamInfoCache = LruCache<String, Pair<Long, StreamInfo>>(64)

    suspend fun search(query: String, filter: String, pageToken: String?): SearchPageDto {
        if (pageToken != null) {
            val (handler, page) = pages.remove(pageToken) ?: throw BridgeException("bad_request", "Страница устарела")
            val more = SearchInfo.getMoreItems(yt, handler, page)
            return SearchPageDto(more.items.mapNotNull { it.toSearchItem(official = false) }, remember(handler, more.nextPage))
        }
        return when (filter) {
            "songs" -> firstNonEmpty(query, Filters.MUSIC_SONGS, Filters.MUSIC_VIDEOS, official = true)
            "videos" -> searchOnce(query, Filters.VIDEOS)
            "albums" -> albums(query)
            "artists" -> firstNonEmpty(query, Filters.MUSIC_ARTISTS, Filters.CHANNELS)
            "playlists" -> firstNonEmpty(query, Filters.MUSIC_PLAYLISTS, Filters.PLAYLISTS)
            else -> coroutineScope {
                val songs = async { runCatching { searchOnce(query, Filters.MUSIC_SONGS, official = true) }.getOrNull() }
                val videos = searchOnce(query, Filters.VIDEOS)
                val songItems = songs.await()?.items.orEmpty()
                val seen = songItems.mapNotNull { it.track?.id }.toHashSet()
                SearchPageDto(songItems + videos.items.filter { it.track?.id !in seen }, videos.nextPage)
            }
        }
    }

    fun suggestions(query: String): List<String> =
        if (query.isBlank()) emptyList() else yt.suggestionExtractor.suggestionList(query).take(8)

    private fun searchOnce(query: String, contentFilter: String, official: Boolean = false): SearchPageDto {
        val handler = yt.searchQHFactory.fromQuery(query, listOf(contentFilter), "")
        val info = SearchInfo.getInfo(yt, handler)
        return SearchPageDto(info.relatedItems.mapNotNull { it.toSearchItem(official) }, remember(handler, info.nextPage))
    }

    /** YouTube Music filters occasionally come back empty after layout changes; fall back to the plain filter. */
    private fun firstNonEmpty(query: String, primary: String, fallback: String, official: Boolean = false): SearchPageDto {
        val first = runCatching { searchOnce(query, primary, official) }.getOrNull()
        return if (first != null && first.items.isNotEmpty()) first else searchOnce(query, fallback)
    }

    private fun albums(query: String): SearchPageDto {
        val direct = runCatching { searchOnce(query, Filters.MUSIC_ALBUMS) }.getOrNull()
        if (direct != null && direct.items.isNotEmpty()) return direct
        val playlists = searchOnce(query, Filters.MUSIC_PLAYLISTS)
        val albumsOnly = playlists.items.filter { it.collection?.kind == "album" }
        return SearchPageDto(albumsOnly.ifEmpty { playlists.items }, playlists.nextPage)
    }

    private fun remember(handler: SearchQueryHandler, page: Page?): String? {
        if (page == null || !Page.isValid(page)) return null
        if (pages.size > 64) pages.clear()
        return UUID.randomUUID().toString().also { pages[it] = handler to page }
    }

    fun streamInfo(videoId: String, maxAgeMs: Long = 30 * 60_000L): StreamInfo {
        synchronized(streamInfoCache) {
            streamInfoCache.get(videoId)?.let { (at, info) -> if (System.currentTimeMillis() - at < maxAgeMs) return info }
        }
        val info = StreamInfo.getInfo(yt, watchUrl(videoId))
        synchronized(streamInfoCache) { streamInfoCache.put(videoId, System.currentTimeMillis() to info) }
        return info
    }

    fun trackDetails(videoId: String): TrackDetailsDto {
        val info = streamInfo(videoId)
        val track = TrackDto(
            id = "yt:$videoId",
            source = "yt",
            title = info.name,
            artist = info.uploaderName.orEmpty(),
            durationMs = info.duration * 1000,
            artwork = info.thumbnails.best(),
            url = watchUrl(videoId),
            artistUrl = info.uploaderUrl,
            official = info.uploaderName.orEmpty().endsWith(" - Topic"),
            views = info.viewCount.takeIf { it >= 0 },
        )
        val related = info.relatedItems.filterIsInstance<StreamInfoItem>().mapNotNull { it.toTrack(official = false) }
        return TrackDetailsDto(track, related)
    }

    fun collection(url: String): CollectionPageDto {
        val info = PlaylistInfo.getInfo(yt, url)
        val items = info.relatedItems.toMutableList()
        var next = info.nextPage
        var guard = 0
        while (next != null && Page.isValid(next) && items.size < MAX_COLLECTION && guard++ < 6) {
            val more = PlaylistInfo.getMoreItems(yt, url, next)
            items += more.items
            next = more.nextPage
        }
        val tracks = items.mapNotNull { it.toTrack(official = false) }
        val collection = CollectionDto(
            kind = if (isAlbumUrl(url)) "album" else "playlist",
            id = "ytpl:${info.id}",
            title = info.name,
            subtitle = info.uploaderName,
            artwork = info.thumbnails.best() ?: tracks.firstOrNull()?.artwork,
            url = url,
            count = info.streamCount.takeIf { it >= 0 } ?: tracks.size.toLong(),
        )
        return CollectionPageDto(collection, tracks)
    }

    suspend fun artist(url: String): ArtistPageDto = coroutineScope {
        val info = ChannelInfo.getInfo(yt, url)
        val trackTab = info.tabs.firstOrNull { ChannelTabs.TRACKS in it.contentFilters }
            ?: info.tabs.firstOrNull { ChannelTabs.VIDEOS in it.contentFilters }
        val albumTab = info.tabs.firstOrNull { ChannelTabs.ALBUMS in it.contentFilters }
            ?: info.tabs.firstOrNull { ChannelTabs.PLAYLISTS in it.contentFilters }
        val tracksJob = async { trackTab?.let { runCatching { ChannelTabInfo.getInfo(yt, it).relatedItems }.getOrNull() }.orEmpty() }
        val albumsJob = async { albumTab?.let { runCatching { ChannelTabInfo.getInfo(yt, it).relatedItems }.getOrNull() }.orEmpty() }
        val official = info.name.endsWith(" - Topic")
        var tracks = tracksJob.await().mapNotNull { it.toTrack(official) }
        if (tracks.isEmpty()) {
            tracks = runCatching { searchOnce(info.name.removeSuffix(" - Topic"), Filters.VIDEOS).items.mapNotNull { it.track } }
                .getOrDefault(emptyList())
        }
        ArtistPageDto(
            artist = ArtistDto(
                id = "ytch:${info.id}",
                name = info.name,
                artwork = info.avatars.best(),
                url = url,
                subscribers = info.subscriberCount.takeIf { it >= 0 },
            ),
            banner = info.banners.best(),
            tracks = tracks.take(50),
            albums = albumsJob.await().mapNotNull { (it as? PlaylistInfoItem)?.toCollection() },
        )
    }

    private fun InfoItem.toSearchItem(official: Boolean): SearchItemDto? = when (this) {
        is StreamInfoItem -> toTrack(official)?.let { SearchItemDto("track", track = it) }
        is PlaylistInfoItem -> toCollection().let { SearchItemDto(it.kind, collection = it) }
        is ChannelInfoItem -> SearchItemDto(
            "artist",
            artist = ArtistDto("ytch:${url.substringAfterLast('/')}", name, thumbnails.best(), url, subscriberCount.takeIf { it >= 0 }),
        )
        else -> null
    }

    private fun InfoItem.toTrack(official: Boolean): TrackDto? {
        val item = this as? StreamInfoItem ?: return null
        val videoId = runCatching { yt.streamLHFactory.getId(item.url) }.getOrNull() ?: return null
        if (item.duration <= 0 && item.streamType.name.contains("LIVE")) return null
        val uploader = item.uploaderName.orEmpty()
        return TrackDto(
            id = "yt:$videoId",
            source = "yt",
            title = item.name,
            artist = uploader,
            durationMs = item.duration.coerceAtLeast(0) * 1000,
            artwork = item.thumbnails.best(),
            url = watchUrl(videoId),
            artistUrl = item.uploaderUrl,
            official = official || uploader.endsWith(" - Topic"),
            views = item.viewCount.takeIf { it >= 0 },
        )
    }

    private fun PlaylistInfoItem.toCollection(): CollectionDto = CollectionDto(
        kind = if (isAlbumUrl(url)) "album" else "playlist",
        id = "ytpl:${url.substringAfter("list=").substringBefore('&')}",
        title = name,
        subtitle = uploaderName,
        artwork = thumbnails.best(),
        url = url,
        count = streamCount.takeIf { it >= 0 },
    )

    companion object {
        private const val MAX_COLLECTION = 300

        fun watchUrl(videoId: String) = "https://www.youtube.com/watch?v=$videoId"

        /** YouTube Music album playlists use the OLAK5uy_ prefix. */
        fun isAlbumUrl(url: String) = url.contains("list=OLAK5uy_")

        fun List<Image>.best(): String? = maxByOrNull { if (it.width > 0) it.width else it.height }?.url
    }
}
