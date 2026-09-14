package org.prayer.bridge

import net.mamoe.mirai.console.data.AutoSavePluginConfig
import net.mamoe.mirai.console.data.ValueDescription
import net.mamoe.mirai.console.data.value

/**
 * 插件配置，落在 config/org.prayer.prayer-bridge/config.yml。
 * token 属凭据，该目录不应提交进 Git。
 */
object BridgeConfig : AutoSavePluginConfig("config") {
    @ValueDescription("WS 模式：client=插件主动连 Prayer（默认）；server=插件监听端口等 Prayer 连入")
    val wsMode: String by value("client")

    @ValueDescription("[client 模式] Prayer WS 服务端地址。跨公网必须用 wss://，裸 ws:// 会明文传 token 与聊天内容")
    val wsUrl: String by value("ws://127.0.0.1:3002")

    @ValueDescription("接入凭据。client 模式作 Authorization 头上报；server 模式用于校验 Prayer 连入的 Bearer token")
    val token: String by value("")

    @ValueDescription("本接入端标识，需与 Prayer 后台配置的 clientId 一致")
    val clientId: String by value("mirai-1")

    @ValueDescription("[server 模式] 监听地址。默认仅回环，仅当 Prayer 在他机时才改为 0.0.0.0 并务必配强 token + 外层 TLS")
    val serverHost: String by value("127.0.0.1")

    @ValueDescription("[server 模式] 监听端口。避开 3000(Next.js)/3001(NapCat)/3002(client 模式默认)")
    val serverPort: Int by value(3003)

    @ValueDescription("只转发这些群（群号）。留空表示转发全部群")
    val allowedGroups: MutableList<Long> by value(mutableListOf())

    @ValueDescription("是否转发图片（base64 内联，会显著增大帧体积）")
    val forwardImages: Boolean by value(true)

    @ValueDescription("单条消息最多转发几张图片")
    val maxImagesPerMessage: Int by value(3)

    @ValueDescription("[client 模式] 重连初始退避毫秒，指数增长至 maxBackoffMs")
    val backoffMs: Int by value(1000)

    @ValueDescription("[client 模式] 重连最大退避毫秒")
    val maxBackoffMs: Int by value(60000)

    /** 拍平为不含 mirai 类型的传输参数；错误配置拒绝启动。 */
    fun toTransportSettings(): TransportSettings {
        val mode = when (wsMode.trim().lowercase()) {
            "server" -> WsMode.SERVER
            "client" -> WsMode.CLIENT
            else -> throw IllegalArgumentException("wsMode must be client or server")
        }
        return TransportSettings(
            mode = mode,
            token = token.trim(),
            clientId = clientId.trim(),
            wsUrl = wsUrl.trim(),
            backoffMs = backoffMs.toLong(),
            maxBackoffMs = maxBackoffMs.toLong(),
            serverHost = serverHost.trim(),
            serverPort = serverPort,
        )
    }
}
