package app.youmusic.cloud

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.graphics.Typeface
import android.net.Uri
import app.youmusic.data.AppPaths
import app.youmusic.data.LibraryRepository
import app.youmusic.model.TrackDto
import app.youmusic.net.Http
import okhttp3.Request
import java.io.File

/**
 * Brings audio the user sent to the Telegram bot into the library as own files (`local:tg-…`).
 * Cover: the one from Telegram, else [artwork] (a matched song's cover from the UI), else a generated one.
 */
class TelegramImporter(
    private val server: ServerClient,
    private val library: LibraryRepository,
    private val paths: AppPaths,
    filesDir: File,
) {
    private val dir = File(filesDir, "telegram").apply { mkdirs() }

    suspend fun import(track: TgTrackDto, artwork: String?): TrackDto {
        val id = "local:tg-${track.id}"
        val ext = EXT[track.mime] ?: "mp3"
        val file = File(dir, "${AppPaths.safe(track.id)}.$ext")
        if (!file.exists()) server.download("/api/tg/file/${track.id}", file)
        val art = paths.artFile(id)
        if (!art.exists()) {
            val fetched = listOfNotNull(track.cover, artwork).any { url -> runCatching { fetch(url, art) }.isSuccess }
            if (!fetched) generateCover(track.title, track.artist, art)
        }
        val dto = TrackDto(
            id = id,
            source = "local",
            title = track.title,
            artist = track.artist,
            durationMs = track.durationMs,
            artwork = paths.artUrl(id),
            url = Uri.fromFile(file).toString(),
            official = true,
        )
        library.upsertTracks(listOf(dto))
        // The copy on the server is no longer needed once the file is on the phone.
        runCatching { server.tgDelete(track.id) }
        return dto
    }

    private fun fetch(url: String, dest: File) {
        Http.client.newCall(Request.Builder().url(url).build()).execute().use { r ->
            check(r.isSuccessful)
            val bytes = r.body.bytes()
            check(bytes.size > 1000)
            dest.writeBytes(bytes)
        }
    }

    /** A soft two-tone gradient picked from the title, with the title's first letters. */
    private fun generateCover(title: String, artist: String, dest: File) {
        val size = 600
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        val hue = ((title + artist).hashCode().toLong() and 0xffff) % 360
        val a = Color.HSVToColor(floatArrayOf(hue.toFloat(), 0.45f, 0.55f))
        val b = Color.HSVToColor(floatArrayOf(((hue + 40) % 360).toFloat(), 0.55f, 0.28f))
        canvas.drawRect(0f, 0f, size.toFloat(), size.toFloat(), Paint().apply { shader = LinearGradient(0f, 0f, size.toFloat(), size.toFloat(), a, b, Shader.TileMode.CLAMP) })
        val letters = title.split(Regex("\\s+")).filter { it.firstOrNull()?.isLetterOrDigit() == true }.take(2).joinToString("") { it.first().uppercase() }.ifEmpty { "♪" }
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.argb(225, 255, 255, 255)
            textSize = size * 0.36f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            textAlign = Paint.Align.CENTER
        }
        canvas.drawText(letters, size / 2f, size / 2f - (paint.descent() + paint.ascent()) / 2, paint)
        dest.outputStream().use { bmp.compress(Bitmap.CompressFormat.JPEG, 90, it) }
        bmp.recycle()
    }

    companion object {
        private val EXT = mapOf(
            "audio/mpeg" to "mp3", "audio/mp4" to "m4a", "audio/x-m4a" to "m4a", "audio/ogg" to "ogg", "audio/flac" to "flac",
            "audio/x-flac" to "flac", "audio/wav" to "wav", "audio/x-wav" to "wav", "audio/aac" to "aac", "audio/opus" to "opus",
        )
    }
}
