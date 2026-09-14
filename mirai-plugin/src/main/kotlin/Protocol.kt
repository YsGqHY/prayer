package org.prayer.bridge

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

/**
 * 桥接协议 v1，与 Prayer 侧 lib/channels/mirai/protocol.ts 的 zod schema 一一对应。
 * 改动任一侧都必须同步另一侧，否则帧会被对端校验拒绝。
 */
const val PROTOCOL_VERSION = 1
const val MAX_FRAME_BYTES = 8 * 1024 * 1024

/**
 * 帧编解码集中到一处，client / server / 插件三方共用同一 Json 实例与编码逻辑，
 * 避免各自 new Json 造成配置漂移（如 encodeDefaults 不一致导致漏字段）。
 */
@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
object FrameCodec {
    val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }

    fun encode(frame: HelloFrame): String = json.encodeToString(HelloFrame.serializer(), frame)
    fun encode(frame: MessageFrame): String {
        var bounded = frame
        var payload = json.encodeToString(MessageFrame.serializer(), bounded)
        while (payload.toByteArray(Charsets.UTF_8).size > MAX_FRAME_BYTES && !bounded.images.isNullOrEmpty()) {
            bounded = bounded.copy(images = bounded.images!!.dropLast(1).takeIf { it.isNotEmpty() })
            payload = json.encodeToString(MessageFrame.serializer(), bounded)
        }
        require(payload.toByteArray(Charsets.UTF_8).size <= MAX_FRAME_BYTES) { "Message exceeds frame limit" }
        return payload
    }
    fun encode(frame: ResponseFrame): String = json.encodeToString(ResponseFrame.serializer(), frame)
    fun encode(frame: PongFrame): String = json.encodeToString(PongFrame.serializer(), frame)

    /** 解析入站帧；畸形帧交由调用方按上下文处理（记录/忽略/拒绝）。 */
    fun decodeInbound(raw: String): InboundFrame =
        json.decodeFromString(InboundFrame.serializer(), raw).also {
            require(it.v == PROTOCOL_VERSION) { "Unsupported protocol version" }
        }
}

@Serializable
data class ChatDto(
    val id: String,
    val name: String = "",
)

@Serializable
data class ImageDto(
    /** base64，不带 data: 前缀 */
    val data: String,
    val mediaType: String,
)

/** 出站：连接后首帧，声明身份与所辖会话 */
@Serializable
data class HelloFrame(
    val v: Int = PROTOCOL_VERSION,
    val type: String = "hello",
    val clientId: String,
    val botId: Long,
    val chats: List<ChatDto> = emptyList(),
)

/** 出站：群消息 */
@Serializable
data class MessageFrame(
    val v: Int = PROTOCOL_VERSION,
    val type: String = "message",
    /** 必须稳定：Prayer 侧据此去重，重连重放不应导致重复回答 */
    val messageId: String,
    val chatId: String,
    val userId: String,
    val senderRole: String? = null,
    val text: String = "",
    val botMentioned: Boolean = false,
    val quoted: String? = null,
    val forwarded: String? = null,
    val images: List<ImageDto>? = null,
    val ts: Long? = null,
)

/** 出站：回查应答 */
@Serializable
data class ResponseFrame(
    val v: Int = PROTOCOL_VERSION,
    val type: String = "response",
    val echo: String,
    val data: JsonElement? = null,
    val error: String? = null,
)

@Serializable
data class PongFrame(
    val v: Int = PROTOCOL_VERSION,
    val type: String = "pong",
)

/**
 * 入站帧的宽松形态：一次解析出所有可能字段，按 type 分派。
 * 不用 sealed class + 多态序列化，是为了避免 kotlinx 的 classDiscriminator
 * 与本协议 type 字段语义冲突，也让未知 type 能安全忽略而非抛异常。
 */
@Serializable
data class InboundFrame(
    val v: Int,
    val type: String,
    // send
    val chatId: String? = null,
    val text: String? = null,
    val replyToId: String? = null,
    // request
    val echo: String? = null,
    val action: String? = null,
    val params: Map<String, String>? = null,
)

/** 成员列表回查的返回项；字段名对齐 OneBot 习惯，便于后台复用展示 */
@Serializable
data class MemberDto(
    @SerialName("user_id") val userId: Long,
    @SerialName("nickname") val nickname: String,
    @SerialName("card") val card: String = "",
    @SerialName("role") val role: String = "member",
)
