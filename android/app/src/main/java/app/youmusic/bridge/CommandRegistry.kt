package app.youmusic.bridge

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.serializer

val BridgeJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
}

/** Error with a stable `code` the UI can branch on (see docs/bridge.md). */
class BridgeException(val code: String, message: String) : Exception(message)

/** Marker for commands that take no arguments. */
@kotlinx.serialization.Serializable
class NoArgs

typealias RawHandler = suspend (JsonElement) -> JsonElement

/**
 * Typed command table. A new native feature is one [BridgeModule] that registers its commands here;
 * nothing else in the bridge needs to change.
 */
class CommandRegistry {
    private val handlers = HashMap<String, RawHandler>()

    fun <A, R> register(name: String, argSer: KSerializer<A>, resSer: KSerializer<R>, handler: suspend (A) -> R) {
        check(name !in handlers) { "Duplicate bridge command: $name" }
        handlers[name] = { raw ->
            val args = BridgeJson.decodeFromJsonElement(argSer, raw)
            BridgeJson.encodeToJsonElement(resSer, handler(args))
        }
    }

    inline fun <reified A, reified R> command(name: String, noinline handler: suspend (A) -> R) =
        register(name, serializer<A>(), serializer<R>(), handler)

    fun find(name: String): RawHandler? = handlers[name]

    val names: Set<String> get() = handlers.keys

    companion object {
        val EMPTY_ARGS: JsonElement = JsonObject(emptyMap())
    }
}

fun interface BridgeModule {
    fun register(registry: CommandRegistry)
}
