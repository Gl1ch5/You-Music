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
data class NetworkStateDto(val online: Boolean, val unmetered: Boolean)

class NetworkMonitor(context: Context) {
    private val cm = context.getSystemService(ConnectivityManager::class.java)
    private val _state = MutableStateFlow(current())
    val state: StateFlow<NetworkStateDto> = _state

    val online: Boolean get() = _state.value.online

    init {
        cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = update()
            override fun onLost(network: Network) = update()
            override fun onAvailable(network: Network) = update()
        })
    }

    private fun update() {
        val next = current()
        if (next != _state.value) {
            _state.value = next
            EventBus.emit("network", next)
        }
    }

    private fun current(): NetworkStateDto {
        val caps = cm.getNetworkCapabilities(cm.activeNetwork)
        val online = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true ||
            caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        val unmetered = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == true
        return NetworkStateDto(online, unmetered)
    }
}
