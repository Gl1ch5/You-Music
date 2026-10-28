package app.youmusic.mods

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import app.youmusic.bridge.BridgeException
import app.youmusic.bridge.BridgeHost
import app.youmusic.bridge.BridgeJson
import app.youmusic.data.AppPaths
import app.youmusic.model.InstalledModDto
import app.youmusic.model.StagedModDto
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.util.UUID
import java.util.zip.ZipInputStream

/**
 * Mod files on disk. Installing is two-step: [stageZip]/[stageTree] unpack into a staging folder and return the
 * manifest so the UI can ask the user to approve permissions; [install] then moves it into files/mods/<id>.
 * Enabled/disabled state and permission grants live in the UI (key/value storage).
 */
class ModStore(private val context: Context, private val paths: AppPaths) {

    fun list(): List<InstalledModDto> = paths.mods.listFiles().orEmpty().filter { it.isDirectory }.mapNotNull { dir ->
        runCatching { InstalledModDto(dir.name, readManifest(dir), "${BridgeHost.ORIGIN}/mods/${dir.name}/") }.getOrNull()
    }

    fun stageZip(uri: Uri): StagedModDto {
        val stage = newStage()
        context.contentResolver.openInputStream(uri)?.use { raw ->
            ZipInputStream(raw.buffered()).use { zip ->
                var total = 0L
                while (true) {
                    val entry = zip.nextEntry ?: break
                    val out = File(stage, entry.name).canonicalFile
                    if (!out.path.startsWith(stage.canonicalPath + File.separator)) throw BridgeException("bad_mod", "Недопустимый путь в архиве")
                    if (entry.isDirectory) {
                        out.mkdirs()
                    } else {
                        out.parentFile?.mkdirs()
                        out.outputStream().use { total += zip.copyTo(it) }
                        if (total > MAX_BYTES) throw BridgeException("bad_mod", "Мод слишком большой")
                    }
                }
            }
        } ?: throw BridgeException("bad_mod", "Не удалось открыть файл")
        return finishStage(stage)
    }

    fun stageTree(tree: Uri): StagedModDto {
        val stage = newStage()
        val root = DocumentFile.fromTreeUri(context, tree) ?: throw BridgeException("bad_mod", "Папка недоступна")
        fun copy(dir: DocumentFile, target: File, depth: Int) {
            if (depth > 8) return
            dir.listFiles().forEach { f ->
                val name = f.name ?: return@forEach
                if (name.contains('/') || name == "..") return@forEach
                if (f.isDirectory) copy(f, File(target, name).apply { mkdirs() }, depth + 1)
                else context.contentResolver.openInputStream(f.uri)?.use { input ->
                    File(target, name).outputStream().use { input.copyTo(it) }
                }
            }
        }
        copy(root, stage, 0)
        return finishStage(stage)
    }

    fun install(stageId: String): InstalledModDto {
        val stage = File(paths.modStage, stageId)
        val root = contentRoot(stage)
        val id = modId(readManifest(root))
        val target = File(paths.mods, id)
        target.deleteRecursively()
        if (!root.renameTo(target)) {
            root.copyRecursively(target, overwrite = true)
        }
        stage.deleteRecursively()
        return InstalledModDto(id, readManifest(target), "${BridgeHost.ORIGIN}/mods/$id/")
    }

    fun remove(id: String) {
        File(paths.mods, sanitize(id)).deleteRecursively()
    }

    private fun newStage(): File {
        paths.modStage.listFiles()?.forEach { it.deleteRecursively() }
        return File(paths.modStage, UUID.randomUUID().toString()).apply { mkdirs() }
    }

    private fun finishStage(stage: File): StagedModDto {
        val manifest = readManifest(contentRoot(stage))
        modId(manifest)
        return StagedModDto(stage.name, manifest)
    }

    /** Archives often wrap everything in one top-level folder; accept both layouts. */
    private fun contentRoot(stage: File): File {
        if (File(stage, MANIFEST).exists()) return stage
        val dirs = stage.listFiles().orEmpty().filter { it.isDirectory }
        return dirs.singleOrNull()?.takeIf { File(it, MANIFEST).exists() }
            ?: throw BridgeException("bad_mod", "В моде нет manifest.json")
    }

    private fun readManifest(dir: File): JsonObject {
        val file = File(dir, MANIFEST)
        if (!file.exists()) throw BridgeException("bad_mod", "В моде нет manifest.json")
        return runCatching { BridgeJson.parseToJsonElement(file.readText()).jsonObject }
            .getOrElse { throw BridgeException("bad_mod", "manifest.json повреждён") }
    }

    private fun modId(manifest: JsonObject): String {
        val id = manifest["id"]?.jsonPrimitive?.contentOrNull ?: throw BridgeException("bad_mod", "В manifest.json нет id")
        if (!ID_PATTERN.matches(id)) throw BridgeException("bad_mod", "Недопустимый id мода: $id")
        return id
    }

    private fun sanitize(id: String) = id.takeIf { ID_PATTERN.matches(it) } ?: throw BridgeException("bad_request", "Недопустимый id")

    companion object {
        private const val MANIFEST = "manifest.json"
        private const val MAX_BYTES = 20L shl 20
        private val ID_PATTERN = Regex("^[a-z0-9][a-z0-9._-]{1,63}$")
    }
}
