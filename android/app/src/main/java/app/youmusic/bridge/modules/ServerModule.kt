package app.youmusic.bridge.modules

import app.youmusic.bridge.BridgeModule
import app.youmusic.bridge.CommandRegistry
import app.youmusic.bridge.NoArgs
import app.youmusic.cloud.ServerClient
import app.youmusic.cloud.ServerStatusDto
import kotlinx.serialization.Serializable

@Serializable data class ServerAuthArgs(val login: String, val password: String, val register: Boolean = false)
@Serializable data class ServerProxyArgs(val on: Boolean)

/** Optional You Music account: sign in, cloud sync, free proxy. */
class ServerModule(private val server: ServerClient) : BridgeModule {
    override fun register(registry: CommandRegistry) = with(registry) {
        command<NoArgs, ServerStatusDto>("serverStatus") { server.refresh() }
        command<ServerAuthArgs, ServerStatusDto>("serverAuth") { server.auth(it.login, it.password, it.register) }
        command<NoArgs, ServerStatusDto>("serverLogout") { server.logout() }
        command<NoArgs, ServerStatusDto>("serverSync") { server.sync() }
        command<ServerProxyArgs, ServerStatusDto>("serverProxy") { server.setProxy(it.on) }
    }
}
