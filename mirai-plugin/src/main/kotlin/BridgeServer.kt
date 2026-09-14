package org.prayer.bridge

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.java_websocket.WebSocket
import org.java_websocket.drafts.Draft
import org.java_websocket.exceptions.InvalidDataException
import org.java_websocket.framing.CloseFrame
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.handshake.ServerHandshakeBuilder
import org.java_websocket.server.WebSocketServer
import java.net.InetSocketAddress
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * Prayer WS 服务端传输：插件监听端口，等 Prayer 连入。server 模式使用。
 *
 * 鉴权在 WS 升级之前完成：onWebsocketHandshakeReceivedAsServer 校验
 * Authorization: Bearer <token>，不匹配直接抛 InvalidDataException 拒绝握手，
 * 不进入 onOpen。单活动会话：已有活动会话时拒绝新连接（握手层拒 + onOpen 兜底）。
 *
 * 安全：默认仅监听 127.0.0.1。若改 0.0.0.0 暴露到公网，token 是唯一屏障，
 * 且明文 ws 会泄露 token 与聊天内容——必须叠加外层 TLS（反代）。
 */
class BridgeServer(
    private val scope: CoroutineScope,
    private val log: BridgeLog,
    private val settings: TransportSettings,
) : BridgeTransport {
    override var onSessionOpen: (suspend (BridgeSession) -> Unit)? = null
    override var onFrame: (suspend (BridgeSession, InboundFrame) -> Unit)? = null
    override var onSessionClose: (suspend (BridgeSession) -> Unit)? = null

    private val active = AtomicReference<ServerSession?>(null)
    private val sessionSeq = AtomicLong(0)
    private val started = AtomicBoolean(false)
    private val stopped = AtomicBoolean(false)
    private val startLatch = CountDownLatch(1)
    @Volatile private var startError: String? = null
    private val lock = Any()

    private var server: WebSocketServer? = null

    override fun isReady(): Boolean = active.get()?.isOpen() == true
    override fun currentSession(): BridgeSession? = active.get()?.takeIf { it.isOpen() }

    private inner class ServerSession(
        val conn: WebSocket,
        override val id: String,
    ) : BridgeSession {
        private val job = SupervisorJob(scope.coroutineContext[Job])
        override val coroutineScope = CoroutineScope(scope.coroutineContext + job)
        override fun isOpen(): Boolean = !stopped.get() && active.get() === this && conn.isOpen
        override fun send(payload: String): Boolean {
            if (!isOpen()) return false
            return try {
                conn.send(payload)
                true
            } catch (e: Exception) {
                log.warn("发送失败: ${e.message}")
                false
            }
        }
        override fun close() {
            cancel()
            try { conn.closeConnection(CloseFrame.GOING_AWAY, "session closed") } catch (_: Exception) {}
        }
        fun cancel() { job.cancel() }
    }

    override fun start() {
        if (!started.compareAndSet(false, true)) return
        val token = settings.token
        if (token.isEmpty()) {
            // 无 token 的服务端等于裸奔：拒绝启动而不是开一个谁都能连的端口
            startError = "token 未配置，server 模式拒绝启动（否则任何人都能连入）"
            log.error(startError!!)
            startLatch.countDown()
            return
        }
        val srv = object : WebSocketServer(InetSocketAddress(settings.serverHost, settings.serverPort)) {
            override fun onWebsocketHandshakeReceivedAsServer(
                conn: WebSocket?,
                draft: Draft?,
                request: ClientHandshake?,
            ): ServerHandshakeBuilder {
                // 1) Bearer 鉴权：升级前完成，不匹配直接拒握手
                val auth = request?.getFieldValue("Authorization")?.trim().orEmpty()
                val ok = auth.startsWith("Bearer ") && MessageDigest.isEqual(auth.removePrefix("Bearer ").trim().toByteArray(), token.toByteArray())
                if (!ok) {
                    throw InvalidDataException(CloseFrame.POLICY_VALIDATION, "Unauthorized")
                }
                // 2) 单活动会话：已有在连的会话时拒绝重复连接
                if (active.get()?.isOpen() == true) {
                    throw InvalidDataException(CloseFrame.POLICY_VALIDATION, "Duplicate session rejected")
                }
                return super.onWebsocketHandshakeReceivedAsServer(conn, draft, request)
            }

            override fun onOpen(conn: WebSocket, handshake: ClientHandshake?) {
                val session = ServerSession(conn, "server-" + sessionSeq.incrementAndGet())
                // 兜底并发：两个握手都通过时，第一个占位，其余关闭
                val accepted = synchronized(lock) {
                    val cur = active.get()
                    if (stopped.get() || (cur != null && cur.isOpen())) false
                    else { active.set(session); true }
                }
                if (!accepted) {
                    log.warn("已有活动会话，拒绝重复连接 ${conn.remoteSocketAddress}")
                    try { conn.close(CloseFrame.POLICY_VALIDATION, "Duplicate session rejected") } catch (_: Exception) {}
                    return
                }
                conn.setAttachment(session)
                log.info("Prayer 已连入: ${conn.remoteSocketAddress} sid=${session.id}")
                session.coroutineScope.launch { onSessionOpen?.invoke(session) }
            }

            override fun onMessage(conn: WebSocket, message: String?) {
                val raw = message ?: return
                val session = conn.getAttachment<ServerSession>() ?: return
                session.coroutineScope.launch {
                    if (!session.isOpen()) return@launch
                    try {
                        onFrame?.invoke(session, FrameCodec.decodeInbound(raw))
                    } catch (e: Exception) {
                        if (e is CancellationException) throw e
                        log.warn("入站帧解析失败: ${e.message}")
                    }
                }
            }

            override fun onClose(conn: WebSocket, code: Int, reason: String?, remote: Boolean) {
                val session = conn.getAttachment<ServerSession>() ?: return
                // 只有当前活动会话就是它时才清空，避免被拒的重复连接把活动会话误清
                active.compareAndSet(session, null)
                session.cancel()
                log.info("Prayer 断开 sid=${session.id} code=$code reason=$reason")
                scope.launch { onSessionClose?.invoke(session) }
            }

            override fun onError(conn: WebSocket?, ex: Exception?) {
                if (conn == null) {
                    startError = ex?.message ?: "server error"
                    startLatch.countDown()
                    log.error("服务端错误（可能端口占用）: ${ex?.message}")
                } else {
                    log.warn("连接错误: ${ex?.message}")
                }
            }

            override fun onStart() {
                log.info("Prayer Bridge 监听 ${settings.serverHost}:${settings.serverPort}")
                startLatch.countDown()
            }
        }
        srv.isReuseAddr = true
        srv.connectionLostTimeout = 90
        server = srv
        srv.start()
    }

    /** 等待监听就绪；返回 true 表示已 onStart。测试用。 */
    fun awaitStarted(timeoutMs: Long): Boolean =
        startLatch.await(timeoutMs, TimeUnit.MILLISECONDS) && startError == null

    fun startError(): String? = startError

    override fun stop() {
        if (!stopped.compareAndSet(false, true)) return
        active.getAndSet(null)?.close()
        val srv = server ?: return
        server = null
        try {
            // 有界：最多等 1s，避免 onDisable 卡死
            srv.stop(1000)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
        } catch (_: Exception) {
        }
    }
}
