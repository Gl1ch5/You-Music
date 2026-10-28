package app.youmusic.system

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import app.youmusic.MainActivity
import app.youmusic.R
import app.youmusic.data.DownloadStatus
import app.youmusic.model.DownloadDto

/**
 * Ongoing notifications for long background work the user started or should know about:
 * the app update download and the offline music queue. Updates are throttled (Android drops too frequent ones).
 */
class ProgressNotifications(private val context: Context) {
    private val nm = context.getSystemService(NotificationManager::class.java)
    private val lock = Any()

    /** Queued and running downloads: track id → title. */
    private val active = LinkedHashMap<String, String>()
    private var current: String? = null
    private var currentProgress = 0f
    private var finished = 0
    private var lastDownloadPost = 0L
    private var lastUpdatePost = 0L

    init {
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, context.getString(R.string.download_channel), NotificationManager.IMPORTANCE_LOW),
        )
    }

    fun update(status: String, progress: Float, version: String) = synchronized(lock) {
        when (status) {
            "downloading" -> {
                val now = System.currentTimeMillis()
                if (now - lastUpdatePost < THROTTLE_MS && progress > 0f) return
                lastUpdatePost = now
                post(
                    UPDATE_ID,
                    builder(Uri.parse("youmusic://updates"))
                        .setContentTitle("Загружается новая версия You Music")
                        .setContentText(listOf(version, percent(progress)).filter { it.isNotEmpty() }.joinToString(" · "))
                        .setProgress(100, (progress * 100).toInt(), progress <= 0f)
                        .setOngoing(true),
                )
            }
            else -> nm.cancel(UPDATE_ID)
        }
    }

    fun download(dto: DownloadDto) = synchronized(lock) {
        val id = dto.trackId
        when (dto.status) {
            DownloadStatus.QUEUED -> active[id] = dto.track?.title ?: active[id].orEmpty()
            DownloadStatus.RUNNING -> {
                active[id] = dto.track?.title ?: active[id].orEmpty()
                if (current != id) lastDownloadPost = 0
                current = id
                currentProgress = dto.progress
            }
            else -> {
                if (active.remove(id) != null && dto.status == DownloadStatus.DONE) finished++
                if (current == id) {
                    current = null
                    currentProgress = 0f
                }
                lastDownloadPost = 0
            }
        }
        showDownloads()
    }

    private fun showDownloads() {
        if (active.isEmpty()) {
            nm.cancel(DOWNLOAD_ID)
            if (finished > 0) {
                post(
                    DOWNLOAD_ID,
                    builder(null)
                        .setContentTitle("Загрузка музыки завершена")
                        .setContentText("Скачано треков: $finished")
                        .setAutoCancel(true)
                        .setTimeoutAfter(10_000),
                )
            }
            finished = 0
            return
        }
        val now = System.currentTimeMillis()
        if (now - lastDownloadPost < THROTTLE_MS) return
        lastDownloadPost = now
        val title = current?.let { active[it] }?.takeIf { it.isNotEmpty() }
        val left = active.size
        post(
            DOWNLOAD_ID,
            builder(null)
                .setContentTitle(if (left == 1) "Скачивается трек" else "Скачивается музыка · осталось $left")
                .setContentText(title?.let { listOf(it, percent(currentProgress)).filter(String::isNotEmpty).joinToString(" · ") } ?: "В очереди")
                .setProgress(100, (currentProgress * 100).toInt(), current == null)
                .setOngoing(true),
        )
    }

    private fun builder(link: Uri?): NotificationCompat.Builder {
        val intent = Intent(context, MainActivity::class.java).apply { if (link != null) data = link }
        val open = PendingIntent.getActivity(context, 2, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(open)
            .setOnlyAlertOnce(true)
            .setSilent(true)
    }

    private fun post(id: Int, builder: NotificationCompat.Builder) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        runCatching { nm.notify(id, builder.build()) }
    }

    private fun percent(p: Float) = if (p > 0f) "${(p * 100).toInt()}%" else ""

    companion object {
        private const val CHANNEL = "progress"
        private const val UPDATE_ID = 43
        private const val DOWNLOAD_ID = 44
        private const val THROTTLE_MS = 700L
    }
}
