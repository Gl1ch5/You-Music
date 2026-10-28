package app.youmusic.bridge

import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.serializer

data class BridgeEvent(val name: String, val data: JsonElement)

/** App-wide native → UI event stream. Producers live longer than the Activity; the bridge forwards while attached. */
object EventBus {
    private val flow = MutableSharedFlow<BridgeEvent>(extraBufferCapacity = 128, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    val events: SharedFlow<BridgeEvent> = flow

    fun <T> emit(name: String, ser: KSerializer<T>, data: T) {
        flow.tryEmit(BridgeEvent(name, BridgeJson.encodeToJsonElement(ser, data)))
    }

    inline fun <reified T> emit(name: String, data: T) = emit(name, serializer<T>(), data)
}
