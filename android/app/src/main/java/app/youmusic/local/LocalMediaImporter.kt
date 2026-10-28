package app.youmusic.local

import android.content.Context
import android.content.Intent
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.OpenableColumns
import androidx.documentfile.provider.DocumentFile
import app.youmusic.data.AppPaths
import app.youmusic.data.LibraryRepository
import app.youmusic.model.TrackDto
import java.security.MessageDigest

/** Imports the user's own audio files (picked files or a whole folder) as `local:` tracks. */
class LocalMediaImporter(
    private val context: Context,
    private val library: LibraryRepository,
    private val paths: AppPaths,
) {
    suspend fun importFiles(uris: List<Uri>): List<TrackDto> {
        uris.forEach(::persist)
        return save(uris.mapNotNull(::read))
    }

    suspend fun importTree(tree: Uri): List<TrackDto> {
        persist(tree)
        val root = DocumentFile.fromTreeUri(context, tree) ?: return emptyList()
        val files = mutableListOf<Uri>()
        fun walk(dir: DocumentFile, depth: Int) {
            if (depth > 6) return
            dir.listFiles().forEach { f ->
                when {
                    f.isDirectory -> walk(f, depth + 1)
                    f.type?.startsWith("audio/") == true -> files += f.uri
                }
            }
        }
        walk(root, 0)
        return save(files.mapNotNull(::read))
    }

    suspend fun remove(id: String) {
        val track = library.track(id) ?: return
        library.deleteTrack(id)
        paths.artFile(id).delete()
        track.url?.let { uri ->
            runCatching { context.contentResolver.releasePersistableUriPermission(Uri.parse(uri), Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        }
    }

    private suspend fun save(tracks: List<TrackDto>): List<TrackDto> {
        library.upsertTracks(tracks)
        return tracks
    }

    private fun persist(uri: Uri) {
        runCatching { context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    }

    private fun read(uri: Uri): TrackDto? = runCatching {
        val id = "local:" + sha1(uri.toString()).take(16)
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(context, uri)
            val fileName = displayName(uri)?.substringBeforeLast('.') ?: "Без названия"
            val title = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE)?.takeIf { it.isNotBlank() }
            val artist = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST)
                ?: retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST)
            val picture = retriever.embeddedPicture
            if (picture != null) paths.artFile(id).writeBytes(picture)
            TrackDto(
                id = id,
                source = "local",
                title = title ?: fileName.substringAfter(" - ", fileName),
                artist = artist ?: if (title == null && " - " in fileName) fileName.substringBefore(" - ") else "",
                album = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM),
                durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0,
                artwork = if (picture != null) paths.artUrl(id) else null,
                url = uri.toString(),
                official = true,
            )
        } finally {
            retriever.release()
        }
    }.getOrNull()

    private fun displayName(uri: Uri): String? =
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }

    private fun sha1(s: String) = MessageDigest.getInstance("SHA-1").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
}
