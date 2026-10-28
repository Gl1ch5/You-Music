package app.youmusic.net

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import app.youmusic.bridge.EventBus
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.Serializable

@Serializable
data class NetworkStateDto(val online: Boolean, val unmetered: Boolean, val vpn: Boolean)

class NetworkMonitor(context: Context) {
    private val cm = context.getSystemService(ConnectivityManager::class.java)
    private val _state = MutableStateFlow(current())
    val state: StateFlow<NetworkStateDto> = _state

    val online: Boolean get() = _state.value.online
    val vpn: Boolean get() = _state.value.vpn

    private val listeners = mutableListOf<(old: NetworkStateDto, new: NetworkStateDto) -> Unit>()

    /** Called on every change (the public IP may have changed: VPN toggled, Wi-Fi ↔ mobile). */
    fun onChange(listener: (old: NetworkStateDto, new: NetworkStateDto) -> Unit) {
        synchronized(listeners) { listeners += listener }
    }

    init {
        cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = update()
            override fun onLost(network: Network) = update()
            override fun onAvailable(network: Network) = update()
        })
    }

    private fun update() {
        val next = current()
        val old = _state.value
        if (next != old) {
            _state.value = next
            EventBus.emit("network", next)
            synchronized(listeners) { listeners.toList() }.forEach { it(old, next) }
        }
    }

    private fun current(): NetworkStateDto {
        val caps = cm.getNetworkCapabilities(cm.activeNetwork)
        val online = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true ||
            caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        val unmetered = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == true
        val vpn = caps?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
        return NetworkStateDto(online, unmetered, vpn)
    }
}
