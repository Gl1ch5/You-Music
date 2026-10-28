package app.youmusic.system

import android.net.Uri
import app.youmusic.model.InsetsDto

/** Things only the visible Activity can do. Bridge modules depend on this interface, not on MainActivity. */
interface ActivityHost {
    suspend fun pickDocuments(mimeTypes: Array<String>, multiple: Boolean): List<Uri>
    suspend fun pickTree(): Uri?
    suspend fun createDocument(name: String, mime: String): Uri?
    fun haptic(kind: String)
    fun share(text: String)
    fun openUrl(url: String)
    fun moveToBack()
    fun setLightSystemBars(light: Boolean)
    fun insets(): InsetsDto
    fun consumeDeepLink(): String?
}
