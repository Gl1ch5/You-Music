package app.youmusic.bridge.modules

import app.youmusic.ai.AiClient
import app.youmusic.ai.AiConfigDto
import app.youmusic.ai.AiMessage
import app.youmusic.bridge.BridgeModule
import app.youmusic.bridge.CommandRegistry
import app.youmusic.bridge.NoArgs
import kotlinx.serialization.Serializable

@Serializable data class AiConfigArgs(val baseUrl: String? = null, val model: String? = null, val key: String? = null, val enabled: Boolean? = null)
@Serializable data class AiChatArgs(val messages: List<AiMessage>, val temperature: Double = 0.9, val tier: String = "fast")

class AiModule(private val ai: AiClient) : BridgeModule {
    override fun register(registry: CommandRegistry) = with(registry) {
        command<NoArgs, AiConfigDto>("aiConfig") { ai.config() }
        command<AiConfigArgs, AiConfigDto>("aiConfigure") { ai.configure(it.baseUrl, it.model, it.key, it.enabled) }
        command<AiChatArgs, String>("aiChat") { ai.chat(it.messages, it.temperature, it.tier) }
    }
}
