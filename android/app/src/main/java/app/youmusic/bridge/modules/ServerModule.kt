package app.youmusic.bridge.modules

import app.youmusic.bridge.BridgeModule
import app.youmusic.bridge.CommandRegistry
import app.youmusic.bridge.NoArgs
import app.youmusic.cloud.ServerClient
import app.youmusic.cloud.ServerStatusDto
import app.youmusic.cloud.TelegramImporter
import app.youmusic.cloud.TgLinkDto
import app.youmusic.cloud.TgListDto
import app.youmusic.cloud.TgTrackDto
import app.youmusic.model.TrackDto
import kotlinx.serialization.Serializable

@Serializable data class ServerAuthArgs(val login: String, val password: String, val register: Boolean = false)
@Serializable data class ServerProxyArgs(val on: Boolean)
@Serializable data class TgImportArgs(val track: TgTrackDto, val artwork: String? = null)
@Serializable data class TgDeleteArgs(val id: String)

/** Optional You Music account: sign in, cloud sync, free proxy, import from Telegram. */
class ServerModule(private val server: ServerClient, private val telegram: TelegramImporter) : BridgeModule {
    override fun register(registry: CommandRegistry) = with(registry) {
        command<NoArgs, ServerStatusDto>("serverStatus") { server.refresh() }
        command<ServerAuthArgs, ServerStatusDto>("serverAuth") { server.auth(it.login, it.password, it.register) }
        command<NoArgs, ServerStatusDto>("serverLogout") { server.logout() }
        command<NoArgs, ServerStatusDto>("serverSync") { server.sync() }
        command<ServerProxyArgs, ServerStatusDto>("serverProxy") { server.setProxy(it.on) }
        command<NoArgs, TgLinkDto>("tgLink") { server.tgLink() }
        command<NoArgs, TgListDto>("tgTracks") { server.tgTracks() }
        command<TgImportArgs, TrackDto>("tgImport") { telegram.import(it.track, it.artwork) }
        command<TgDeleteArgs, Unit>("tgDelete") { server.tgDelete(it.id) }
    }
}
