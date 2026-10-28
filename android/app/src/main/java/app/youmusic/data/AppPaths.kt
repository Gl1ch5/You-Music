package app.youmusic.data

import android.content.Context
import android.net.Uri
import app.youmusic.bridge.BridgeHost
import java.io.File

/**
 * Internal storage layout. Directories under `files/` and `cache/` that the UI may read are served by
 * WebViewAssetLoader under the same names (see MainActivity), e.g. files/art → https://appassets…/art/.
 */
class AppPaths(context: Context) {
    val downloads = File(context.filesDir, "downloads").apply { mkdirs() }
    val art = File(context.filesDir, "art").apply { mkdirs() }
    val mods = File(context.filesDir, "mods").apply { mkdirs() }
    val blur = File(context.cacheDir, "blur").apply { mkdirs() }
    val modStage = File(context.cacheDir, "mod-stage").apply { mkdirs() }
    val media = File(context.cacheDir, "media")

    fun artFile(trackId: String) = File(art, "${safe(trackId)}.jpg")

    fun artUrl(trackId: String) = "${BridgeHost.ORIGIN}/art/${safe(trackId)}.jpg"

    /** Artwork the platform (notification, lock screen) can load: local file when we have one. */
    fun platformArtwork(trackId: String, remote: String?): Uri? {
        val local = artFile(trackId)
        return if (local.exists()) Uri.fromFile(local) else remote?.let(Uri::parse)
    }

    companion object {
        fun safe(id: String) = id.replace(Regex("[^A-Za-z0-9_-]"), "_")
    }
}
