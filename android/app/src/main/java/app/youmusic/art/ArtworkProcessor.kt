package app.youmusic.art

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import android.graphics.Rect
import androidx.core.graphics.ColorUtils
import androidx.core.graphics.scale
import app.youmusic.bridge.BridgeHost
import app.youmusic.data.AppPaths
import app.youmusic.model.PaletteDto
import app.youmusic.net.Http
import okhttp3.Request
import java.io.File
import java.security.MessageDigest

/**
 * Dynamic colour source: a blurred, half-desaturated copy of the cover (rendered once, cached as JPEG and served to
 * the UI as an image — no CSS filters) plus a muted accent tone for the glow behind the cover.
 */
class ArtworkProcessor(private val paths: AppPaths) {

    fun palette(url: String): PaletteDto {
        val key = MessageDigest.getInstance("SHA-1").digest(url.toByteArray()).joinToString("") { "%02x".format(it) }.take(20)
        val image = File(paths.blur, "$key.jpg")
        val colorFile = File(paths.blur, "$key.txt")
        if (image.exists() && colorFile.exists()) return PaletteDto(blurUrl(key), colorFile.readText())

        val bytes = load(url) ?: return PaletteDto(null, null)
        val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
        opts.inSampleSize = Integer.highestOneBit((minOf(opts.outWidth, opts.outHeight) / 128).coerceAtLeast(1))
        opts.inJustDecodeBounds = false
        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return PaletteDto(null, null)

        val square = centerSquare(decoded, 96)
        val color = mutedTone(square)
        val blurred = blur(square)
        image.outputStream().use { blurred.compress(Bitmap.CompressFormat.JPEG, 82, it) }
        colorFile.writeText(color)
        return PaletteDto(blurUrl(key), color)
    }

    private fun blurUrl(key: String) = "${BridgeHost.ORIGIN}/blur/$key.jpg"

    private fun load(url: String): ByteArray? {
        if (url.startsWith(BridgeHost.ORIGIN + "/art/")) {
            return File(paths.art, url.substringAfterLast('/')).takeIf { it.exists() }?.readBytes()
        }
        if (!url.startsWith("http")) return null
        return runCatching {
            Http.client.newCall(Request.Builder().url(url).build()).execute().use { if (it.isSuccessful) it.body.bytes() else null }
        }.getOrNull()
    }

    private fun centerSquare(src: Bitmap, size: Int): Bitmap {
        val side = minOf(src.width, src.height)
        val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val srcRect = Rect((src.width - side) / 2, (src.height - side) / 2, (src.width + side) / 2, (src.height + side) / 2)
        Canvas(out).drawBitmap(src, srcRect, Rect(0, 0, size, size), Paint(Paint.FILTER_BITMAP_FLAG))
        return out
    }

    /** Downscale/upscale passes give a smooth, cheap blur; saturation is halved so covers tint rather than paint. */
    private fun blur(src: Bitmap): Bitmap {
        var b = src
        for (size in intArrayOf(24, 12, 8)) b = b.scale(size, size, true)
        val up = b.scale(48, 48, true).scale(160, 160, true)
        val out = Bitmap.createBitmap(160, 160, Bitmap.Config.ARGB_8888)
        val paint = Paint(Paint.FILTER_BITMAP_FLAG).apply {
            colorFilter = ColorMatrixColorFilter(ColorMatrix().apply { setSaturation(0.5f) })
        }
        Canvas(out).drawBitmap(up, 0f, 0f, paint)
        return out
    }

    private fun mutedTone(src: Bitmap): String {
        val small = src.scale(16, 16, true)
        var bestScore = -1f
        var best = floatArrayOf(0f, 0f, 0.4f)
        val hsl = FloatArray(3)
        for (x in 0 until 16) for (y in 0 until 16) {
            ColorUtils.colorToHSL(small.getPixel(x, y), hsl)
            // Prefer colourful mid-tones over near-black/near-white pixels.
            val score = hsl[1] * (1f - kotlin.math.abs(hsl[2] - 0.5f) * 2f)
            if (score > bestScore) {
                bestScore = score
                best = hsl.copyOf()
            }
        }
        best[1] = best[1].coerceAtMost(0.38f)
        best[2] = best[2].coerceIn(0.32f, 0.5f)
        return "#%06X".format(ColorUtils.HSLToColor(best) and 0xFFFFFF)
    }
}
