package app.youmusic.net

import okhttp3.Authenticator
import okhttp3.Call
import okhttp3.ConnectionPool
import okhttp3.Credentials
import okhttp3.Dispatcher
import okhttp3.OkHttpClient
import java.net.InetSocketAddress
import java.net.PasswordAuthentication
import java.net.Proxy
import java.util.concurrent.TimeUnit

/** Shared HTTP stack. The client is rebuilt when the proxy changes; always go through [client] or [callFactory]. */
object Http {
    const val DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0"

    private val base: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            // Searches, related videos and track data go out in parallel; the defaults (5 per host) queue them.
            .dispatcher(Dispatcher().apply { maxRequests = 64; maxRequestsPerHost = 16 })
            .connectionPool(ConnectionPool(16, 5, TimeUnit.MINUTES))
            .build()
    }

    @Volatile
    var client: OkHttpClient = base
        private set

    /** For long-lived consumers (Media3) so they pick up proxy changes without being recreated. */
    val callFactory = Call.Factory { request -> client.newCall(request) }

    fun useProxy(proxy: ProxyConfig?) {
        client = if (proxy == null) base else withProxy(proxy)
    }

    fun withProxy(proxy: ProxyConfig): OkHttpClient {
        val type = if (proxy.type == "http") Proxy.Type.HTTP else Proxy.Type.SOCKS
        val builder = base.newBuilder().proxy(Proxy(type, InetSocketAddress.createUnresolved(proxy.host, proxy.port)))
        if (!proxy.user.isNullOrEmpty()) {
            if (type == Proxy.Type.HTTP) {
                builder.proxyAuthenticator(Authenticator { _, response ->
                    if (response.request.header("Proxy-Authorization") != null) null
                    else response.request.newBuilder().header("Proxy-Authorization", Credentials.basic(proxy.user, proxy.pass.orEmpty())).build()
                })
            } else {
                // SOCKS5 credentials go through the JVM-wide authenticator.
                java.net.Authenticator.setDefault(object : java.net.Authenticator() {
                    override fun getPasswordAuthentication(): PasswordAuthentication? =
                        if (requestingHost == proxy.host || requestingPort == proxy.port) PasswordAuthentication(proxy.user, proxy.pass.orEmpty().toCharArray()) else null
                })
            }
        }
        return builder.build()
    }
}

data class ProxyConfig(val type: String, val host: String, val port: Int, val user: String?, val pass: String?)
