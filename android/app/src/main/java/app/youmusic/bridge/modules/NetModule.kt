package app.youmusic.bridge.modules

import app.youmusic.bridge.BridgeModule
import app.youmusic.bridge.CommandRegistry
import app.youmusic.bridge.NoArgs
import app.youmusic.net.ProxyDto
import app.youmusic.net.ProxyManager
import app.youmusic.net.ProxyStateDto
import app.youmusic.update.UpdateManager
import app.youmusic.update.UpdateStateDto
import app.youmusic.update.UpdateWorker
import kotlinx.serialization.Serializable

@Serializable data class LinkArgs(val link: String)
@Serializable data class ProxyIdArgs(val id: String)
@Serializable data class EnabledArgs(val enabled: Boolean)

/** Proxies and OTA updates. */
class NetModule(
    private val context: android.content.Context,
    private val proxies: ProxyManager,
    private val updates: UpdateManager,
) : BridgeModule {
    override fun register(registry: CommandRegistry) = with(registry) {
        command<NoArgs, ProxyStateDto>("proxyState") { proxies.state() }
        command<LinkArgs, ProxyDto>("proxyAdd") { proxies.add(it.link) }
        command<ProxyIdArgs, Unit>("proxyRemove") { proxies.remove(it.id) }
        command<ProxyIdArgs, Unit>("proxySelect") { proxies.select(it.id) }
        command<EnabledArgs, Unit>("proxySetEnabled") { proxies.setEnabled(it.enabled) }
        command<ProxyIdArgs, Long>("proxyPing") { proxies.ping(it.id) }
        command<ProxyIdArgs, String>("proxyShareLink") { proxies.shareLink(it.id) }

        command<NoArgs, UpdateStateDto>("updateState") { updates.state }
        command<NoArgs, UpdateStateDto>("updateCheck") { updates.check() }
        command<NoArgs, UpdateStateDto>("updateDownload") { updates.download() }
        command<NoArgs, Unit>("updateInstall") { updates.install() }
        command<EnabledArgs, Unit>("updateSchedule") { UpdateWorker.schedule(context, it.enabled) }
    }
}
