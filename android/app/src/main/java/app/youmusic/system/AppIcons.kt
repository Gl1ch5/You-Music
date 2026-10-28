package app.youmusic.system

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager

/**
 * Launcher icon picker. Each icon is an `<activity-alias>` of MainActivity in the manifest; exactly one is enabled.
 * Ids: "classic" and "01".."20" (previews in web/public/app-icons).
 */
class AppIcons(private val context: Context) {
    private val pm = context.packageManager

    val ids: List<String> = listOf("classic") + (1..20).map { "%02d".format(it) }

    private fun component(id: String) =
        ComponentName(context, "app.youmusic." + if (id == "classic") "IconClassic" else "Icon$id")

    private fun enabled(id: String): Boolean = when (pm.getComponentEnabledSetting(component(id))) {
        PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
        PackageManager.COMPONENT_ENABLED_STATE_DEFAULT -> id == DEFAULT
        else -> false
    }

    fun current(): String = ids.firstOrNull(::enabled) ?: DEFAULT

    fun set(id: String) {
        require(id in ids) { "Нет такой иконки" }
        if (id == current()) return
        // Enable the new alias first: with no launcher entry at all some launchers drop the app from the home screen.
        pm.setComponentEnabledSetting(component(id), PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP)
        for (other in ids) {
            if (other != id) {
                pm.setComponentEnabledSetting(component(other), PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP)
            }
        }
    }

    companion object {
        const val DEFAULT = "10"
    }
}
