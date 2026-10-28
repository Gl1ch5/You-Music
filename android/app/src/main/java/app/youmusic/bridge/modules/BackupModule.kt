package app.youmusic.bridge.modules

import app.youmusic.bridge.BridgeModule
import app.youmusic.bridge.CommandRegistry
import app.youmusic.bridge.NoArgs
import app.youmusic.data.BackupFolderDto
import app.youmusic.data.BackupManager
import app.youmusic.data.BackupStatusDto
import app.youmusic.system.ActivityHost
import kotlinx.serialization.Serializable

@Serializable data class BackupFolderArgs(val enabled: Boolean)

/** Full backup: export/import of everything and the auto backup folder. */
class BackupModule(private val backup: BackupManager, private val host: ActivityHost) : BridgeModule {
    override fun register(registry: CommandRegistry) = with(registry) {
        command<NoArgs, String>("backupExport") { backup.export() }
        command<JsonTextArgs, Int>("backupImport") { backup.import(it.json) }
        command<NoArgs, BackupStatusDto>("backupStatus") { backup.status() }
        command<BackupFolderArgs, BackupFolderDto?>("backupSetFolder") { a ->
            if (!a.enabled) return@command backup.setFolder(null)
            host.pickTree()?.let { backup.setFolder(it) }
        }
        command<NoArgs, Int>("backupRestoreFolder") { backup.restoreFromFolder() }
        command<NoArgs, Boolean>("backupNow") { backup.saveNow() }
    }
}
