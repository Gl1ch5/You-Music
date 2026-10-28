package app.youmusic.bridge.modules

import app.youmusic.bridge.BridgeModule
import app.youmusic.bridge.CommandRegistry
import app.youmusic.bridge.NoArgs
import app.youmusic.model.InstalledModDto
import app.youmusic.model.StagedModDto
import app.youmusic.mods.ModStore
import app.youmusic.system.ActivityHost
import kotlinx.serialization.Serializable

@Serializable data class ModPickArgs(val kind: String = "zip")
@Serializable data class StageArgs(val stageId: String)
@Serializable data class ModIdArgs(val id: String)

class ModsModule(private val store: ModStore, private val host: ActivityHost) : BridgeModule {
    override fun register(registry: CommandRegistry) = with(registry) {
        command<NoArgs, List<InstalledModDto>>("modsList") { store.list() }
        command<ModPickArgs, StagedModDto?>("modStage") { a ->
            if (a.kind == "folder") host.pickTree()?.let(store::stageTree)
            else host.pickDocuments(arrayOf("application/zip", "application/x-zip-compressed", "application/octet-stream"), false)
                .firstOrNull()?.let(store::stageZip)
        }
        command<StageArgs, InstalledModDto>("modInstall") { store.install(it.stageId) }
        command<ModIdArgs, Unit>("modRemove") { store.remove(it.id) }
    }
}
