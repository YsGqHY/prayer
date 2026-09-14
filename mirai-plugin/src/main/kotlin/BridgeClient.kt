package org.prayer.bridge

import kotlinx.coroutines.*
import org.java_websocket.client.WebSocketClient
import org.java_websocket.drafts.Draft_6455
import org.java_websocket.framing.CloseFrame
import org.java_websocket.handshake.ServerHandshake
import java.net.URI
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/** 主动连接传输；连接中与已连接 socket 都归当前代数所有。 */
class BridgeClient(
    private val scope: CoroutineScope,
    private val log: BridgeLog,
    private val settings: TransportSettings,
) : BridgeTransport {
    override var onSessionOpen: (suspend (BridgeSession) -> Unit)? = null
    override var onFrame: (suspend (BridgeSession, InboundFrame) -> Unit)? = null
    override var onSessionClose: (suspend (BridgeSession) -> Unit)? = null
    private val stopped = AtomicBoolean(true)
    private val epoch = AtomicLong(0)
    private val sessionSeq = AtomicLong(0)
    private val current = AtomicReference<ClientSession?>(null)
    private var loop: Job? = null

    override fun isReady(): Boolean = current.get()?.isOpen() == true
    override fun currentSession(): BridgeSession? = current.get()?.takeIf { it.isOpen() }

    private inner class ClientSession(
        val client: WebSocketClient,
        val generation: Long,
        override val id: String,
    ) : BridgeSession {
        private val job = SupervisorJob(scope.coroutineContext[Job])
        override val coroutineScope = CoroutineScope(scope.coroutineContext + job)
        override fun isOpen(): Boolean = !stopped.get() && epoch.get() == generation && current.get() === this && client.isOpen
        override fun send(payload: String): Boolean {
            if (!isOpen()) return false
            return try { client.send(payload); true } catch (_: Exception) { false }
        }
        fun cancel() { job.cancel() }
        override fun close() {
            cancel()
            // closeConnection 只结束 WS 状态；握手未完成时必须同时关闭底层 TCP。
            try { client.socket?.close() } catch (_: Exception) {}
            try { client.closeConnection(CloseFrame.GOING_AWAY, "session closed") } catch (_: Exception) {}
        }
    }

    @Synchronized
    override fun start() {
        if (loop?.isActive == true) return
        stopped.set(false)
        val generation = epoch.incrementAndGet()
        loop = scope.launch(CoroutineName("prayer-bridge-ws")) {
            var backoff = settings.backoffMs
            try {
            while (isActive && !stopped.get() && epoch.get() == generation) {
                val session = connectOnce(generation)
                if (session != null) {
                    backoff = settings.backoffMs
                    while (isActive && session.isOpen()) delay(250)
                }
                if (!isActive || stopped.get() || epoch.get() != generation) break
                delay(backoff)
                backoff = (backoff * 2).coerceAtMost(settings.maxBackoffMs)
            }
            } finally {
                if (epoch.get() == generation) current.getAndSet(null)?.close()
            }
        }
    }

    @Synchronized
    override fun stop() {
        if (!stopped.compareAndSet(false, true)) return
        epoch.incrementAndGet()
        current.getAndSet(null)?.close()
        loop?.cancel()
        loop = null
    }

    private suspend fun connectOnce(generation: Long): ClientSession? {
        val holder = AtomicReference<ClientSession?>(null)
        val client = object : WebSocketClient(URI(settings.wsUrl), Draft_6455(), mapOf("Authorization" to "Bearer ${settings.token}"), 10000) {
            override fun onOpen(handshakedata: ServerHandshake?) {
                val session = holder.get() ?: return
                if (!session.isOpen()) { session.close(); return }
                log.info("已连接 Prayer")
                session.coroutineScope.launch { onSessionOpen?.invoke(session) }
            }

            override fun onMessage(message: String?) {
                val session = holder.get() ?: return
                if (message == null || !session.isOpen()) return
                session.coroutineScope.launch {
                    if (!session.isOpen()) return@launch
                    try { onFrame?.invoke(session, FrameCodec.decodeInbound(message)) }
                    catch (e: CancellationException) { throw e }
                    catch (_: Exception) { log.warn("入站帧解析失败") }
                }
            }

            override fun onClose(code: Int, reason: String?, remote: Boolean) {
                val session = holder.get() ?: return
                session.cancel()
                current.compareAndSet(session, null)
                scope.launch { onSessionClose?.invoke(session) }
            }

            override fun onError(ex: Exception?) {
                if (!stopped.get() && epoch.get() == generation) log.warn("连接失败，请检查 Prayer 地址、token 和网络")
            }
        }
        client.connectionLostTimeout = 90
        val session = ClientSession(client, generation, "client-${sessionSeq.incrementAndGet()}")
        holder.set(session)
        synchronized(this) {
            if (stopped.get() || epoch.get() != generation) { session.close(); return null }
            current.set(session)
        }
        try {
            val connected = runInterruptible(Dispatchers.IO) { client.connectBlocking(10, TimeUnit.SECONDS) }
            if (connected && session.isOpen()) return session
        } catch (e: CancellationException) {
            current.compareAndSet(session, null)
            session.close()
            throw e
        } catch (_: Exception) {
            log.warn("连接失败，等待自动重连")
        } finally {
            if (!session.isOpen()) {
                current.compareAndSet(session, null)
                session.close()
            }
        }
        return null
    }
}
