package app.youmusic.bridge.modules

import app.youmusic.art.ArtworkProcessor
import app.youmusic.bridge.BridgeModule
import app.youmusic.bridge.CommandRegistry
import app.youmusic.model.ArtistPageDto
import app.youmusic.model.CollectionPageDto
import app.youmusic.model.LyricsDto
import app.youmusic.model.PaletteDto
import app.youmusic.model.SearchPageDto
import app.youmusic.model.TrackDetailsDto
import app.youmusic.source.FeatureQueryDto
import app.youmusic.source.FeaturesRepository
import app.youmusic.source.ImportRepository
import app.youmusic.source.ImportedListDto
import app.youmusic.source.LyricsRepository
import app.youmusic.source.TrackFeaturesDto
import app.youmusic.source.YouTubeRepository
import kotlinx.serialization.Serializable

@Serializable data class SearchArgs(val query: String, val filter: String = "all", val page: String? = null)
@Serializable data class QueryArgs(val query: String)
@Serializable data class IdArgs(val id: String)
@Serializable data class UrlArgs(val url: String)
@Serializable data class LyricsArgs(val artist: String, val title: String, val durationMs: Long = 0)
@Serializable data class TranslateArgs(val lines: List<String>, val to: String = "ru")
@Serializable data class ChartArgs(val source: String = "yandex")
@Serializable data class FeaturesArgs(val tracks: List<FeatureQueryDto>)

/** Read-only catalogue: YouTube search and pages, lyrics, artwork palettes, audio features, import from other services. */
class CatalogModule(
    private val youtube: YouTubeRepository,
    private val lyrics: LyricsRepository,
    private val artwork: ArtworkProcessor,
    private val importer: ImportRepository,
    private val features: FeaturesRepository,
    private val translator: app.youmusic.source.Translator,
) : BridgeModule {
    override fun register(registry: CommandRegistry) = with(registry) {
        command<SearchArgs, SearchPageDto>("search") { youtube.search(it.query, it.filter, it.page) }
        command<QueryArgs, List<String>>("searchSuggestions") { youtube.suggestions(it.query) }
        command<IdArgs, TrackDetailsDto>("trackDetails") { youtube.trackDetails(it.id.removePrefix("yt:")) }
        command<UrlArgs, CollectionPageDto>("getCollection") { youtube.collection(it.url) }
        command<UrlArgs, ArtistPageDto>("getArtist") { youtube.artist(it.url) }
        command<LyricsArgs, LyricsDto>("lyrics") { lyrics.lyrics(it.artist, it.title, it.durationMs) }
        command<UrlArgs, PaletteDto>("artworkPalette") { artwork.palette(it.url) }
        command<UrlArgs, ImportedListDto>("importFetch") { importer.fetch(it.url) }
        command<ChartArgs, ImportedListDto>("chart") { importer.chart(it.source) }
        command<TranslateArgs, app.youmusic.source.TranslationDto>("translate") { translator.translate(it.lines, it.to) }
        command<FeaturesArgs, Map<String, TrackFeaturesDto>>("trackFeatures") { features.features(it.tracks) }
    }
}
