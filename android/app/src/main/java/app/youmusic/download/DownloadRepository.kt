package app.youmusic.download

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import app.youmusic.bridge.BridgeException
import app.youmusic.bridge.EventBus
import app.youmusic.data.AppDatabase
import app.youmusic.data.AppPaths
import app.youmusic.data.DownloadEntity
import app.youmusic.data.DownloadStatus
import app.youmusic.data.KeyValueStore
import app.youmusic.data.LibraryRepository
import app.youmusic.model.DownloadDto
import app.youmusic.model.TrackDto
import app.youmusic.net.Http
import app.youmusic.source.StreamResolver
import kotlinx.coroutines.ensureActive
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.coroutines.coroutineContext

/** Offline copies of YouTube tracks: queue in WorkManager, chunked HTTP download, files in [AppPaths.downloads]. */
class DownloadRepository(
    private val context: Context,
    private val db: AppDatabase,
    private val paths: AppPaths,
    private val resolver: StreamResolver,
    private val library: LibraryRepository,
    private val kv: KeyValueStore,
) {
    private val ready = ConcurrentHashMap<String, File>()

    suspend fun init() {
        db.downloads().all().filter { it.status == DownloadStatus.DONE }.forEach { d ->
            d.filePath?.let(::File)?.takeIf { it.exists() }?.let { ready[d.trackId] = it }
        }
    }

    /** Completed offline file for a track, used by the player before touching the network. */
    fun localFile(trackId: String): File? = ready[trackId]?.takeIf { it.exists() }

    fun isDownloaded(trackId: String) = localFile(trackId) != null

    suspend fun list(): List<DownloadDto> {
        val rows = db.downloads().all()
        val tracks = rows.map { it.trackId }.chunked(500).flatMap { db.tracks().getAll(it) }.associateBy { it.id }
        return rows.map { it.toDto(tracks[it.trackId]?.toDto()) }
    }

    suspend fun enqueue(tracks: List<TrackDto>, quality: String?) {
        val remote = tracks.filter { it.source == "yt" && !isDownloaded(it.id) }
        if (remote.isEmpty()) return
        library.upsertTracks(remote)
        val q = quality ?: kv.settings.downloadQuality
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(if (kv.settings.wifiOnlyDownloads) NetworkType.UNMETERED else NetworkType.CONNECTED)
            .build()
        val wm = WorkManager.getInstance(context)
        remote.forEach { track ->
            val row = DownloadEntity(track.id, DownloadStatus.QUEUED, 0f, 0, q, null, null, null, System.currentTimeMillis())
            db.downloads().upsert(row)
            emit(row.toDto(track))
            val request = OneTimeWorkRequestBuilder<DownloadWorker>()
                .setInputData(workDataOf(DownloadWorker.KEY_TRACK to track.id, DownloadWorker.KEY_QUALITY to q))
                .setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                .addTag(DownloadWorker.TAG)
                .build()
            wm.enqueueUniqueWork(workName(track.id), ExistingWorkPolicy.REPLACE, request)
        }
    }

    suspend fun remove(trackId: String) {
        WorkManager.getInstance(context).cancelUniqueWork(workName(trackId))
        val row = db.downloads().get(trackId)
        row?.filePath?.let { File(it).delete() }
        partFiles(trackId).forEach { it.delete() }
        ready.remove(trackId)
        db.downloads().delete(trackId)
        library.track(trackId)?.takeIf { it.source == "yt" }?.let { paths.artFile(trackId).delete() }
        EventBus.emit("downloadProgress", DownloadDto(trackId, null, "removed", 0f, 0, row?.quality ?: "", null, null))
    }

    fun totalBytes(): Long = paths.downloads.listFiles()?.sumOf { it.length() } ?: 0

    /** Runs inside [DownloadWorker]. Throws on failure so the worker can decide to retry. */
    suspend fun download(trackId: String, quality: String) {
        val track = library.track(trackId) ?: throw BridgeException("not_found", "Трек не найден")
        val videoId = trackId.removePrefix("yt:")
        update(trackId, DownloadStatus.RUNNING, 0f, 0, null, track)
        var stream = resolver.resolve(videoId, forDownload = true, qualityOverride = quality)
        val target = File(paths.downloads, "${AppPaths.safe(trackId)}.${stream.extension}")
        val part = File(target.path + ".part")
        var done = if (part.exists()) part.length() else 0L
        var total = -1L
        var lastEmit = 0L
        var refreshed = false
        FileOutputStream(part, true).use { out ->
            while (total < 0 || done < total) {
                coroutineContext.ensureActive()
                val end = done + CHUNK - 1
                val request = Request.Builder().url(stream.url)
                    .header("User-Agent", stream.userAgent)
                    .header("Range", "bytes=$done-$end")
                    .build()
                val response = Http.client.newCall(request).execute()
                response.use { r ->
                    if (r.code == 403 && !refreshed) {
                        refreshed = true
                        resolver.invalidate(videoId)
                        stream = resolver.resolve(videoId, forDownload = true, qualityOverride = quality)
                        return@use
                    }
                    if (r.code == 416 && total > 0) return@use
                    if (r.code != 206 && r.code != 200) throw IOException("HTTP ${r.code}")
                    total = r.header("Content-Range")?.substringAfterLast('/')?.toLongOrNull()
                        ?: r.body.contentLength().takeIf { r.code == 200 } ?: throw IOException("Неизвестный размер файла")
                    r.body.byteStream().use { input ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            done += n
                            val now = System.currentTimeMillis()
                            if (now - lastEmit > 300) {
                                lastEmit = now
                                emit(DownloadDto(trackId, null, DownloadStatus.RUNNING, done.toFloat() / total, done, quality))
                            }
                        }
                    }
                    if (r.code == 200) total = done
                }
            }
        }
        if (target.exists()) target.delete()
        if (!part.renameTo(target)) throw IOException("Не удалось сохранить файл")
        saveArtwork(track)
        db.downloads().upsert(
            DownloadEntity(trackId, DownloadStatus.DONE, 1f, target.length(), quality, target.path, paths.artFile(trackId).path, null, System.currentTimeMillis()),
        )
        ready[trackId] = target
        emit(DownloadDto(trackId, track, DownloadStatus.DONE, 1f, target.length(), quality, localArt(trackId)))
    }

    suspend fun markFailed(trackId: String, message: String) {
        update(trackId, DownloadStatus.FAILED, 0f, 0, message, null)
    }

    private fun saveArtwork(track: TrackDto) {
        val file = paths.artFile(track.id)
        if (file.exists()) return
        val videoId = track.id.removePrefix("yt:")
        val urls = listOfNotNull(track.artwork, "https://i.ytimg.com/vi/$videoId/hqdefault.jpg")
        for (url in urls) {
            val ok = runCatching {
                Http.client.newCall(Request.Builder().url(url).build()).execute().use { r ->
                    if (!r.isSuccessful) return@use false
                    file.outputStream().use { r.body.byteStream().copyTo(it) }
                    true
                }
            }.getOrDefault(false)
            if (ok) return
        }
    }

    private fun localArt(trackId: String) = paths.artFile(trackId).takeIf { it.exists() }?.let { paths.artUrl(trackId) }

    private suspend fun update(id: String, status: String, progress: Float, bytes: Long, error: String?, track: TrackDto?) {
        db.downloads().updateProgress(id, status, progress, bytes, error)
        val row = db.downloads().get(id) ?: return
        emit(row.toDto(track))
    }

    private fun partFiles(trackId: String) =
        paths.downloads.listFiles { f -> f.name.startsWith(AppPaths.safe(trackId) + ".") }.orEmpty().toList()

    private fun emit(dto: DownloadDto) = EventBus.emit("downloadProgress", dto)

    private fun DownloadEntity.toDto(track: TrackDto?) =
        DownloadDto(trackId, track, status, progress, bytes, quality, localArt(trackId), error)

    companion object {
        private const val CHUNK = 1L shl 20
        fun workName(trackId: String) = "download-$trackId"
    }
}
