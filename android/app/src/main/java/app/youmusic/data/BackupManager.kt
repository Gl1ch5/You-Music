package app.youmusic.data

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import app.youmusic.ai.AiClient
import app.youmusic.bridge.BridgeException
import app.youmusic.bridge.BridgeJson
import app.youmusic.bridge.EventBus
import app.youmusic.net.ProxyManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable

@Serializable
data class BackupStatusDto(
    /** Human-readable folder of the auto backup, null when it is off. */
    val folder: String? = null,
    val savedAt: Long = 0,
    val error: String? = null,
)

@Serializable
data class BackupFolderDto(
    val status: BackupStatusDto,
    /** The chosen folder already holds a backup (e.g. after a reinstall): the UI offers to restore it. */
    val existing: BackupSummaryDto? = null,
)

@Serializable
data class BackupSummaryDto(val exportedAt: Long, val likes: Int, val playlists: Int, val history: Int)

/**
 * Everything the user would miss after a reinstall: likes, playlists, history and settings (themes, mods' state,
 * proxies). The AI API key is never written out. Besides manual export/import, an auto backup keeps a copy
 * in a folder the user picked (it survives uninstalling the app) and refreshes it shortly after every change.
 */
class BackupManager(
    private val context: Context,
    private val library: LibraryRepository,
    private val kv: KeyValueStore,
    private val proxies: ProxyManager,
    private val ai: AiClient,
    private val scope: CoroutineScope,
) {
    private val lock = Mutex()
    private var pending: Job? = null

    init {
        library.onChanged = { schedule() }
        kv.onChanged = { key -> if (!key.startsWith(PREFIX)) schedule() }
    }

    suspend fun export(): String = BridgeJson.encodeToString(LibraryExport.serializer(), snapshot())

    /** Restores a full backup or an old library export; returns the number of tracks. */
    suspend fun import(json: String): Int {
        val data = library.parse(json)
        val count = library.importData(data)
        if (data.settings.isNotEmpty()) {
            data.settings.forEach { (key, value) ->
                when {
                    key.startsWith(PREFIX) -> Unit
                    key == AiClient.KEY -> ai.restore(value)
                    else -> kv.set(key, value)
                }
            }
            proxies.reload()
        }
        return count
    }

    fun status(): BackupStatusDto = BackupStatusDto(
        folder = folderUri()?.let(::describe),
        savedAt = kv.get(SAVED_AT)?.toLongOrNull() ?: 0,
        error = kv.get(ERROR),
    )

    /** Turns the auto backup on for [tree] (or off for null). Does not overwrite a backup that is already there. */
    suspend fun setFolder(tree: Uri?): BackupFolderDto {
        folderUri()?.let { old ->
            runCatching { context.contentResolver.releasePersistableUriPermission(old, RW) }
        }
        if (tree == null) {
            kv.set(FOLDER, null)
            kv.set(ERROR, null)
            return BackupFolderDto(status())
        }
        runCatching { context.contentResolver.takePersistableUriPermission(tree, RW) }
            .onFailure { throw BridgeException("io", "Нет доступа к папке") }
        kv.set(FOLDER, tree.toString())
        kv.set(ERROR, null)
        val existing = readExisting(tree)
        if (existing == null) saveNow()
        return BackupFolderDto(status(), existing?.let { BackupSummaryDto(it.exportedAt, it.likes.size, it.playlists.size, it.history.size) })
    }

    /** Restores the backup kept in the auto backup folder. */
    suspend fun restoreFromFolder(): Int {
        val tree = folderUri() ?: throw BridgeException("bad_request", "Папка автокопии не выбрана")
        val file = backupFile(tree) ?: throw BridgeException("not_found", "В папке нет резервной копии")
        val text = context.contentResolver.openInputStream(file.uri)?.use { it.readBytes().decodeToString() }
            ?: throw BridgeException("io", "Не удалось прочитать копию")
        return import(text)
    }

    /** Writes the auto backup right away (e.g. before installing an update). Returns false when it is off or failed. */
    suspend fun saveNow(): Boolean = lock.withLock {
        val tree = folderUri() ?: return false
        try {
            val data = snapshot()
            // Never replace a real backup with an empty library (fresh install pointed at the old folder).
            val file = backupFile(tree)
            if (file != null && data.likes.isEmpty() && data.playlists.isEmpty()) return false
            val target = file ?: DocumentFile.fromTreeUri(context, tree)?.createFile("application/json", FILE_NAME)
                ?: throw BridgeException("io", "Не удалось создать файл копии")
            context.contentResolver.openOutputStream(target.uri, "wt")?.use {
                it.write(BridgeJson.encodeToString(LibraryExport.serializer(), data).toByteArray())
            } ?: throw BridgeException("io", "Не удалось записать копию")
            kv.set(SAVED_AT, System.currentTimeMillis().toString())
            kv.set(ERROR, null)
            true
        } catch (e: Exception) {
            kv.set(ERROR, e.message ?: "Не удалось сохранить копию")
            false
        } finally {
            EventBus.emit("backupState", status())
        }
    }

    private fun schedule() {
        if (folderUri() == null) return
        pending?.cancel()
        pending = scope.launch {
            delay(DEBOUNCE_MS)
            saveNow()
        }
    }

    private suspend fun snapshot(): LibraryExport {
        val settings = kv.all().filterKeys { !it.startsWith(PREFIX) }.toMutableMap()
        if (settings.containsKey(AiClient.KEY)) settings[AiClient.KEY] = ai.backup()
        return library.exportData(withHistory = true).copy(settings = settings)
    }

    private fun readExisting(tree: Uri): LibraryExport? {
        val file = backupFile(tree) ?: return null
        val text = runCatching { context.contentResolver.openInputStream(file.uri)?.use { it.readBytes().decodeToString() } }.getOrNull() ?: return null
        return runCatching { library.parse(text) }.getOrNull()
    }

    private fun backupFile(tree: Uri): DocumentFile? =
        DocumentFile.fromTreeUri(context, tree)?.findFile(FILE_NAME)?.takeIf { it.isFile }

    private fun folderUri(): Uri? = kv.get(FOLDER)?.let(Uri::parse)?.takeIf { uri ->
        context.contentResolver.persistedUriPermissions.any { it.uri == uri && it.isWritePermission }
    }

    private fun describe(tree: Uri): String =
        DocumentFile.fromTreeUri(context, tree)?.name ?: tree.lastPathSegment?.substringAfterLast(':') ?: "папка"

    companion object {
        const val FILE_NAME = "you-music-backup.json"
        private const val PREFIX = "backup."
        private const val FOLDER = "backup.folder"
        private const val SAVED_AT = "backup.savedAt"
        private const val ERROR = "backup.error"
        private const val DEBOUNCE_MS = 15_000L
        private const val RW = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
    }
}
