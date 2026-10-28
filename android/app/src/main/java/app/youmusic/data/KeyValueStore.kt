package app.youmusic.data

import android.content.Context
import androidx.core.content.edit
import app.youmusic.bridge.BridgeJson
import kotlinx.serialization.Serializable

/**
 * String key/value storage shared with the UI (settings, themes, mod storage, search history).
 * The UI owns the schema; native code only reads [AppSettings].
 */
class KeyValueStore(context: Context) {
    private val prefs = context.getSharedPreferences("kv", Context.MODE_PRIVATE)

    fun get(key: String): String? = prefs.getString(key, null)

    fun set(key: String, value: String?) {
        prefs.edit { if (value == null) remove(key) else putString(key, value) }
        onChanged?.invoke(key)
    }

    /** Every string entry (for the full backup). */
    fun all(): Map<String, String> = prefs.all.mapNotNull { (k, v) -> (v as? String)?.let { k to it } }.toMap()

    /** Called after every [set] (the auto backup listens). */
    var onChanged: ((String) -> Unit)? = null

    fun keys(prefix: String): List<String> = prefs.all.keys.filter { it.startsWith(prefix) }

    val settings: AppSettings
        get() = get(SETTINGS_KEY)?.let { runCatching { BridgeJson.decodeFromString<AppSettings>(it) }.getOrNull() } ?: AppSettings()

    companion object {
        const val SETTINGS_KEY = "settings"
    }
}

/** Subset of UI settings that native code needs. Unknown keys are ignored. */
@Serializable
data class AppSettings(
    val streamQuality: String = "high",
    val downloadQuality: String = "high",
    val wifiOnlyDownloads: Boolean = false,
    val cacheLimitMb: Int = 2048,
    val autoUpdate: Boolean = true,
    val autoDownloadUpdates: Boolean = true,
    val updateChannel: String = "nightly",
    val crossfadeSec: Int = 4,
)
