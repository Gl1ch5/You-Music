package app.youmusic

import android.content.Context
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.IOException

/** Serves the built web UI from assets/ui (output of `npm run build` in /web). */
class UiPathHandler(private val context: Context) : WebViewAssetLoader.PathHandler {
    override fun handle(path: String): WebResourceResponse? {
        val clean = path.ifEmpty { "index.html" }
        if (clean.contains("..")) return null
        return try {
            val stream = context.assets.open("ui/$clean")
            WebResourceResponse(mime(clean), if (mime(clean).startsWith("text") || clean.endsWith(".js")) "utf-8" else null, stream).apply {
                responseHeaders = mapOf("Cache-Control" to if (clean.startsWith("assets/")) "max-age=31536000, immutable" else "no-cache")
            }
        } catch (_: IOException) {
            null
        }
    }

    private fun mime(path: String) = when (path.substringAfterLast('.').lowercase()) {
        "html" -> "text/html"
        "js", "mjs" -> "text/javascript"
        "css" -> "text/css"
        "json" -> "application/json"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        "woff2" -> "font/woff2"
        "woff" -> "font/woff"
        else -> "application/octet-stream"
    }
}
