package org.prayer.bridge

import kotlinx.coroutines.CoroutineScope
import java.net.URI

/**
 * 传输层抽象：把「客户端主动连」与「服务端被动收」统一到同一套接口，
 * 供 PrayerBridge 无差别使用。本文件不依赖 mirai，也不依赖 BridgeConfig，
 * 以便 BridgeLoopbackTest 在无 mirai 运行时的环境下直接驱动。
 */

/** 极简日志抽象。插件侧用 MiraiLogger 适配，测试侧用 stdout 实现。 */
interface BridgeLog {
    fun info(msg: String)
    fun warn(msg: String)
    fun error(msg: String)
}

/** WS 模式。 */
enum class WsMode { CLIENT, SERVER }

/**
 * 传输参数，从 BridgeConfig 拍平而来，不含 mirai 类型。
 * client 用 wsUrl/token/clientId/backoff；server 用 serverHost/serverPort/token。
 * token 两侧都需要：client 用于握手头，server 用于握手鉴权。
 */
data class TransportSettings(
    val mode: WsMode,
    val token: String,
    val clientId: String,
    // client
    val wsUrl: String = "ws://127.0.0.1:3002",
    val backoffMs: Long = 1000,
    val maxBackoffMs: Long = 60000,
    // server
    val serverHost: String = "127.0.0.1",
    val serverPort: Int = 3003,
) {
    init {
        require(token.length >= 8 && token.all { it.code in 33..126 }) { "token must contain at least 8 visible ASCII characters" }
        require(Regex("[A-Za-z0-9._-]{1,64}").matches(clientId)) { "Invalid clientId" }
        if (mode == WsMode.SERVER) {
            require(serverHost.isNotBlank() && serverPort in 1..65535) { "Invalid server host or port" }
        } else {
            val uri = try { URI(wsUrl) } catch (_: Exception) { throw IllegalArgumentException("Invalid WS URL") }
            require(uri.scheme in listOf("ws", "wss") && !uri.host.isNullOrBlank() && uri.userInfo == null && uri.fragment == null) { "Invalid WS URL" }
            require(backoffMs in 1..60000 && maxBackoffMs in backoffMs..60000) { "Invalid reconnect interval" }
        }
    }
}

/**
 * 一个已建立的双向会话。send 线程安全，失败返回 false 而不抛。
 * 每个会话有稳定 id，用于把异步 response 绑回收到 request 的原会话。
 */
interface BridgeSession {
    val id: String
    val coroutineScope: CoroutineScope
    fun isOpen(): Boolean
    fun send(payload: String): Boolean
    fun close()
}

/**
 * 传输生命周期。start 后开始工作（client 起重连循环 / server 起监听），
 * stop 必须有界且幂等：重复调用安全，且不会无限阻塞。
 *
 * 回调由实现方在「会话确立 / 收到帧 / 会话关闭」时触发，并把 session 作为参数
 * 显式传入——不依赖任何共享可变字段，从根本上规避 onOpen 先于字段赋值的竞态。
 */
interface BridgeTransport {
    fun start()
    fun stop()

    /** 当前是否有可用会话（client：已连接；server：有活动会话）。 */
    fun isReady(): Boolean

    /** 取当前活动会话；无则返回 null。 */
    fun currentSession(): BridgeSession?

    var onSessionOpen: (suspend (BridgeSession) -> Unit)?
    var onFrame: (suspend (BridgeSession, InboundFrame) -> Unit)?
    var onSessionClose: (suspend (BridgeSession) -> Unit)?
}
