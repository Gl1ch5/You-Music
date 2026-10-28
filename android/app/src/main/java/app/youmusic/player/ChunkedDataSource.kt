package app.youmusic.player

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.TransferListener
import java.io.IOException

/**
 * Reads a remote stream as a series of short range requests instead of one long connection.
 * YouTube throttles or drops long-running responses, which shows up as playback stalls mid-track;
 * short ranges finish quickly and a failed one is simply re-requested. A 403 (expired or IP-bound URL)
 * triggers [onForbidden] so the URL gets resolved again, then the chunk is retried.
 */
@UnstableApi
class ChunkedDataSource(
    private val upstream: DataSource,
    private val chunkSize: Long = 2L shl 20,
    private val onForbidden: (Uri) -> Unit,
) : DataSource {
    private var spec: DataSpec? = null
    private var position = 0L
    private var end = C.LENGTH_UNSET.toLong()
    private var chunkLeft = 0L
    private var opened = false

    override fun addTransferListener(transferListener: TransferListener) = upstream.addTransferListener(transferListener)

    override fun open(dataSpec: DataSpec): Long {
        spec = dataSpec
        position = dataSpec.position
        end = if (dataSpec.length != C.LENGTH_UNSET.toLong()) dataSpec.position + dataSpec.length else C.LENGTH_UNSET.toLong()
        openChunk()
        if (end == C.LENGTH_UNSET.toLong()) {
            val total = upstream.responseHeaders.entries.firstOrNull { it.key.equals("Content-Range", true) }
                ?.value?.firstOrNull()?.substringAfterLast('/')?.toLongOrNull()
            if (total != null) end = total
        }
        return if (end == C.LENGTH_UNSET.toLong()) C.LENGTH_UNSET.toLong() else end - dataSpec.position
    }

    private fun openChunk() {
        val base = spec!!
        val remaining = if (end == C.LENGTH_UNSET.toLong()) chunkSize else minOf(chunkSize, end - position)
        val chunk = base.buildUpon().setPosition(position).setLength(remaining).build()
        var attempt = 0
        while (true) {
            try {
                if (opened) upstream.close()
                opened = true
                val len = upstream.open(chunk)
                chunkLeft = if (len == C.LENGTH_UNSET.toLong()) remaining else len
                return
            } catch (e: HttpDataSource.InvalidResponseCodeException) {
                if (e.responseCode == 403 && attempt == 0) onForbidden(base.uri)
                else if (e.responseCode == 416 && end == C.LENGTH_UNSET.toLong()) {
                    chunkLeft = 0
                    end = position
                    return
                } else if (attempt >= MAX_RETRIES) throw e
            } catch (e: IOException) {
                if (attempt >= MAX_RETRIES) throw e
                Thread.sleep(300L * (attempt + 1))
            }
            attempt++
        }
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        if (end != C.LENGTH_UNSET.toLong() && position >= end) return C.RESULT_END_OF_INPUT
        if (chunkLeft <= 0) openChunk()
        if (end != C.LENGTH_UNSET.toLong() && position >= end) return C.RESULT_END_OF_INPUT
        var n = try {
            upstream.read(buffer, offset, minOf(length.toLong(), chunkLeft).toInt())
        } catch (e: IOException) {
            // Connection dropped inside a chunk: reopen from the current position once.
            openChunk()
            upstream.read(buffer, offset, minOf(length.toLong(), chunkLeft).toInt())
        }
        if (n == C.RESULT_END_OF_INPUT) {
            if (end == C.LENGTH_UNSET.toLong() && chunkLeft > 0) return C.RESULT_END_OF_INPUT
            chunkLeft = 0
            if (end != C.LENGTH_UNSET.toLong() && position >= end) return C.RESULT_END_OF_INPUT
            openChunk()
            n = upstream.read(buffer, offset, minOf(length.toLong(), chunkLeft).toInt())
            if (n == C.RESULT_END_OF_INPUT) return n
        }
        position += n
        chunkLeft -= n
        return n
    }

    override fun getUri(): Uri? = upstream.uri

    override fun getResponseHeaders(): Map<String, List<String>> = upstream.responseHeaders

    override fun close() {
        if (opened) upstream.close()
        opened = false
        spec = null
    }

    companion object {
        private const val MAX_RETRIES = 3
    }
}
