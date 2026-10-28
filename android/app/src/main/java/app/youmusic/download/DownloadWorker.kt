package app.youmusic.download

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import app.youmusic.YouMusicApp
import app.youmusic.source.toBridgeException
import kotlinx.coroutines.CancellationException
import java.io.IOException

class DownloadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val trackId = inputData.getString(KEY_TRACK) ?: return Result.failure()
        val quality = inputData.getString(KEY_QUALITY) ?: "high"
        val downloads = YouMusicApp.graph.downloads
        return try {
            downloads.download(trackId, quality)
            Result.success()
        } catch (e: CancellationException) {
            throw e
        } catch (e: IOException) {
            if (runAttemptCount < MAX_ATTEMPTS) Result.retry()
            else fail(downloads, trackId, e)
        } catch (e: Exception) {
            fail(downloads, trackId, e)
        }
    }

    private suspend fun fail(downloads: DownloadRepository, trackId: String, e: Exception): Result {
        downloads.markFailed(trackId, e.toBridgeException().message ?: "Ошибка загрузки")
        return Result.failure()
    }

    companion object {
        const val KEY_TRACK = "track"
        const val KEY_QUALITY = "quality"
        const val TAG = "download"
        private const val MAX_ATTEMPTS = 3
    }
}
