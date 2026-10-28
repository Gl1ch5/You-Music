package app.youmusic.update

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import app.youmusic.BuildConfig
import app.youmusic.bridge.BridgeException
import app.youmusic.bridge.BridgeJson
import app.youmusic.bridge.EventBus
import app.youmusic.data.KeyValueStore
import app.youmusic.net.Http
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import okhttp3.Request
import java.io.File
import java.io.IOException

/** Published by CI next to every APK as version.json. */
@Serializable
data class VersionInfoDto(
    val versionCode: Long,
    val versionName: String,
    val channel: String,
    val apk: String,
    val notes: String? = null,
    val sha: String? = null,
    val publishedAt: String? = null,
)

@Serializable
data class UpdateStateDto(
    val currentVersion: String,
    val currentCode: Long,
    val latest: VersionInfoDto? = null,
    /** idle | checking | uptodate | available | downloading | ready | installing | error */
    val status: String,
    val progress: Float = 0f,
    val error: String? = null,
    val checkedAt: Long = 0,
)

/**
 * OTA updates from GitHub Releases: reads version.json of the chosen channel, downloads the APK in the
 * background and installs it through PackageInstaller (Android asks the user to confirm unless it allows silent updates).
 */
class UpdateManager(private val context: Context, private val kv: KeyValueStore) {
    private val lock = Mutex()
    private val dir = File(context.cacheDir, "updates").apply { mkdirs() }

    @Volatile
    var state = UpdateStateDto(BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE.toLong(), status = "idle")
        private set

    private fun set(next: UpdateStateDto) {
        state = next
        EventBus.emit("updateState", next)
    }

    private fun versionUrl(channel: String) =
        if (channel == "stable") "$REPO/releases/latest/download/version.json" else "$REPO/releases/download/nightly/version.json"

    suspend fun check(autoDownload: Boolean = kv.settings.autoDownloadUpdates): UpdateStateDto = lock.withLock {
        if (state.status in setOf("downloading", "installing")) return state
        set(state.copy(status = "checking", error = null))
        val channel = kv.settings.updateChannel
        val info = try {
            Http.client.newCall(Request.Builder().url(versionUrl(channel)).header("Cache-Control", "no-cache").build()).execute().use { r ->
                if (r.code == 404) throw BridgeException("not_found", "Для канала «$channel» ещё нет релиза")
                if (!r.isSuccessful) throw IOException("GitHub ответил ${r.code}")
                BridgeJson.decodeFromString(VersionInfoDto.serializer(), r.body.string())
            }
        } catch (e: Exception) {
            set(state.copy(status = "error", error = e.message, checkedAt = System.currentTimeMillis()))
            return state
        }
        val newer = info.versionCode > BuildConfig.VERSION_CODE
        val ready = newer && apkFile(info).exists()
        set(state.copy(latest = info, status = if (!newer) "uptodate" else if (ready) "ready" else "available", progress = if (ready) 1f else 0f, checkedAt = System.currentTimeMillis()))
        if (newer && !ready && autoDownload) downloadLocked(info)
        return state
    }

    suspend fun download(): UpdateStateDto = lock.withLock {
        val info = state.latest ?: throw BridgeException("bad_request", "Сначала проверьте обновления")
        downloadLocked(info)
        state
    }

    private fun downloadLocked(info: VersionInfoDto) {
        val target = apkFile(info)
        if (target.exists()) return set(state.copy(status = "ready", progress = 1f))
        dir.listFiles()?.forEach { it.delete() }
        val part = File(target.path + ".part")
        set(state.copy(status = "downloading", progress = 0f))
        try {
            Http.client.newCall(Request.Builder().url(info.apk).build()).execute().use { r ->
                if (!r.isSuccessful) throw IOException("Не удалось скачать APK (${r.code})")
                val total = r.body.contentLength()
                var done = 0L
                var lastEmit = 0L
                part.outputStream().use { out ->
                    r.body.byteStream().use { input ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            done += n
                            val now = System.currentTimeMillis()
                            if (total > 0 && now - lastEmit > 250) {
                                lastEmit = now
                                set(state.copy(progress = done.toFloat() / total))
                            }
                        }
                    }
                }
            }
            if (!part.renameTo(target)) throw IOException("Не удалось сохранить APK")
            set(state.copy(status = "ready", progress = 1f))
        } catch (e: Exception) {
            part.delete()
            set(state.copy(status = "error", error = e.message))
        }
    }

    fun install() {
        val info = state.latest ?: throw BridgeException("bad_request", "Нет загруженного обновления")
        val file = apkFile(info).takeIf { it.exists() } ?: throw BridgeException("bad_request", "APK ещё не скачан")
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            session.openWrite("base.apk", 0, file.length()).use { out ->
                file.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val callback = PendingIntent.getBroadcast(
                context, sessionId,
                Intent(context, InstallResultReceiver::class.java).setPackage(context.packageName),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
            )
            set(state.copy(status = "installing"))
            session.commit(callback.intentSender)
        }
    }

    internal fun onInstallResult(success: Boolean, message: String?) {
        set(state.copy(status = if (success) "uptodate" else "error", error = if (success) null else message))
    }

    private fun apkFile(info: VersionInfoDto) = File(dir, "you-music-${info.versionCode}.apk")

    companion object {
        const val REPO = "https://github.com/Gl1ch5/You-Music"
    }
}

/** Receives PackageInstaller results; asks the user to confirm when Android requires it. */
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val manager = app.youmusic.YouMusicApp.graph.updates
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                else intent.getParcelableExtra(Intent.EXTRA_INTENT)
                confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)?.let(context::startActivity)
            }
            PackageInstaller.STATUS_SUCCESS -> manager.onInstallResult(true, null)
            else -> {
                val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                val hint = if (status == PackageInstaller.STATUS_FAILURE_CONFLICT || status == PackageInstaller.STATUS_FAILURE_INCOMPATIBLE)
                    "Подпись новой сборки не совпадает с установленной — удалите приложение и поставьте APK вручную один раз."
                else msg
                manager.onInstallResult(false, hint ?: "Установка не удалась")
            }
        }
    }
}
