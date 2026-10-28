package app.youmusic.bridge.modules

import android.content.Context
import android.os.Build
import app.youmusic.BuildConfig
import app.youmusic.bridge.BridgeException
import app.youmusic.bridge.BridgeModule
import app.youmusic.bridge.CommandRegistry
import app.youmusic.bridge.NoArgs
import app.youmusic.data.KeyValueStore
import app.youmusic.model.HelloDto
import app.youmusic.model.PickedTextDto
import app.youmusic.net.NetworkMonitor
import app.youmusic.system.ActivityHost
import app.youmusic.system.AppIcons
import kotlinx.serialization.Serializable

@Serializable data class KeyArgs(val key: String)
@Serializable data class KeyValueArgs(val key: String, val value: String?)
@Serializable data class PrefixArgs(val prefix: String)
@Serializable data class KindArgs(val kind: String = "light")
@Serializable data class TextArgs(val text: String)
@Serializable data class LightArgs(val light: Boolean)
@Serializable data class PickTextArgs(val mime: String = "*/*")
@Serializable data class IconArgs(val id: String)
@Serializable data class SaveTextArgs(val name: String, val text: String, val mime: String = "application/json")

/** App info, key/value storage, files and small Activity services (haptics, share, system bars). */
class SystemModule(
    private val context: Context,
    private val kv: KeyValueStore,
    private val network: NetworkMonitor,
    private val host: ActivityHost,
    private val icons: AppIcons,
) : BridgeModule {
    override fun register(registry: CommandRegistry) = with(registry) {
        command<NoArgs, HelloDto>("hello") {
            HelloDto(BuildConfig.VERSION_NAME, BuildConfig.EXTRACTOR_VERSION, Build.VERSION.SDK_INT, network.online, host.insets())
        }
        command<KeyArgs, String?>("kvGet") { kv.get(it.key) }
        command<KeyValueArgs, Unit>("kvSet") { kv.set(it.key, it.value) }
        command<PrefixArgs, List<String>>("kvKeys") { kv.keys(it.prefix) }
        command<KindArgs, Unit>("haptic") { host.haptic(it.kind) }
        command<TextArgs, Unit>("share") { host.share(it.text) }
        command<TextArgs, Unit>("openUrl") { a ->
            if (!a.text.startsWith("https://")) throw BridgeException("bad_request", "Только https-ссылки")
            host.openUrl(a.text)
        }
        command<NoArgs, String>("appIconGet") { icons.current() }
        command<IconArgs, Unit>("appIconSet") { a ->
            if (a.id !in icons.ids) throw BridgeException("bad_request", "Нет такой иконки")
            icons.set(a.id)
        }
        command<NoArgs, Unit>("moveToBack") { host.moveToBack() }
        command<NoArgs, String?>("consumeDeepLink") { host.consumeDeepLink() }
        command<LightArgs, Unit>("setSystemBars") { host.setLightSystemBars(it.light) }
        command<PickTextArgs, PickedTextDto?>("pickTextFile") { a ->
            val uri = host.pickDocuments(arrayOf(a.mime), multiple = false).firstOrNull() ?: return@command null
            val name = uri.lastPathSegment?.substringAfterLast('/') ?: "file"
            val text = context.contentResolver.openInputStream(uri)?.use { it.readBytes().decodeToString() }
                ?: throw BridgeException("io", "Не удалось прочитать файл")
            PickedTextDto(name, text)
        }
        command<SaveTextArgs, Boolean>("saveTextFile") { a ->
            val uri = host.createDocument(a.name, a.mime) ?: return@command false
            context.contentResolver.openOutputStream(uri, "wt")?.use { it.write(a.text.toByteArray()) } ?: return@command false
            true
        }
    }
}
