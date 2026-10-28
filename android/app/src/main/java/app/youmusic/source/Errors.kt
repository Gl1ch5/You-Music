package app.youmusic.source

import app.youmusic.bridge.BridgeException
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerializationException
import org.schabi.newpipe.extractor.exceptions.AgeRestrictedContentException
import org.schabi.newpipe.extractor.exceptions.ContentNotAvailableException
import org.schabi.newpipe.extractor.exceptions.ExtractionException
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException
import java.io.IOException

/** Thrown by the playback data source when a remote track is requested without a network. */
class OfflineException : IOException("Нет сети, а трек не скачан")

/** Extraction failure surfaced through Media3, which only propagates IOExceptions. */
class StreamResolveException(cause: Throwable) : IOException(cause.message, cause)

/** Maps any failure to the stable error codes documented in docs/bridge.md. */
fun Throwable.toBridgeException(): BridgeException = when (this) {
    is BridgeException -> this
    is StreamResolveException -> cause!!.toBridgeException()
    is CancellationException -> BridgeException("cancelled", "Отменено")
    is OfflineException -> BridgeException("offline", message ?: "Нет сети")
    is AgeRestrictedContentException -> BridgeException("unavailable", "Трек доступен только после входа (18+)")
    is ContentNotAvailableException -> BridgeException("unavailable", message ?: "Трек недоступен")
    is ReCaptchaException -> BridgeException("captcha", "YouTube временно ограничил запросы. Попробуйте позже.")
    is ExtractionException -> BridgeException(
        "extraction",
        "Не удалось разобрать ответ YouTube. Скорее всего, нужно обновить приложение.",
    )
    is SerializationException, is IllegalArgumentException -> BridgeException("bad_request", message ?: "Неверные аргументы")
    is IOException -> BridgeException("network", message ?: "Ошибка сети")
    else -> cause?.takeIf { it !== this }?.toBridgeException() ?: BridgeException("internal", message ?: javaClass.simpleName)
}
