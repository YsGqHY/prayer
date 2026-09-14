package org.prayer.bridge

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import java.io.File
import java.security.MessageDigest
import java.net.ServerSocket
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger

/**
 * 无第三方测试框架的 loopback 自测入口（不依赖 mirai）。
 * 直接驱动 BridgeServer + BridgeClient，覆盖：
 *   1) 认证：正确 token 建连、错误 token 被握手层拒
 *   2) 单活动会话：已有会话时重复连接被拒
 *   3) 传输：hello / ping / pong 帧经 FrameCodec 双向往返
 *   4) stop：server 与 client 重复 stop 有界、幂等、不挂起
 *
 * 运行：mirai-plugin 下 `gradlew.bat --offline loopbackTest`。
 */
private class StdLog(private val tag: String) : BridgeLog {
    override fun info(msg: String) = println("[$tag][INFO] $msg")
    override fun warn(msg: String) = println("[$tag][WARN] $msg")
    override fun error(msg: String) = println("[$tag][ERR ] $msg")
}

private var failures = 0
private fun check(name: String, ok: Boolean) {
    println((if (ok) "PASS  " else "FAIL  ") + name)
    if (!ok) failures++
}

private fun freePort(): Int = ServerSocket(0).use { it.localPort }

private fun waitUntil(timeoutMs: Long, cond: () -> Boolean): Boolean {
    val end = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < end) {
        if (cond()) return true
        Thread.sleep(50)
    }
    return cond()
}

private fun clientSettings(port: Int, token: String) = TransportSettings(
    mode = WsMode.CLIENT,
    token = token,
    clientId = "test-client",
    wsUrl = "ws://127.0.0.1:$port",
    backoffMs = 3000,
    maxBackoffMs = 3000,
)

fun main() {
    val fixtures = listOf(
        FrameCodec.encode(HelloFrame(clientId = "test-client", botId = 12345L)),
        FrameCodec.encode(MessageFrame(messageId = "m-1", chatId = "123", userId = "456", text = "hello")),
        FrameCodec.encode(MessageFrame(messageId = "m-2", chatId = "123", userId = "456", senderRole = "admin", quoted = "quote", images = listOf(ImageDto("dGVzdA==", "image/png")))),
        FrameCodec.encode(ResponseFrame(echo = "req-1", data = FrameCodec.json.parseToJsonElement("[]"))),
        FrameCodec.encode(ResponseFrame(echo = "req-2", error = "unsupported action")),
        FrameCodec.encode(PongFrame()),
    )
    val sourceHash = MessageDigest.getInstance("SHA-256").digest(File("src/main/kotlin/Protocol.kt").readBytes()).joinToString("") { "%02x".format(it) }
    File("build/protocol-frames.json").writeText("{\"sourceHash\":\"$sourceHash\",\"frames\":" + fixtures.joinToString(",", "[", "]" ) + "}")
    check("optional 字段不编码 null", fixtures.none { it.contains(":null") })
    check("缺少协议版本拒绝执行", runCatching { FrameCodec.decodeInbound("{\"type\":\"ping\"}") }.isFailure)
    val oversized = MessageFrame(messageId = "large", chatId = "123", userId = "456", images = List(2) { ImageDto("A".repeat(4 * 1024 * 1024), "image/png") })
    check("多图总帧裁剪至 8MiB 内", FrameCodec.encode(oversized).toByteArray(Charsets.UTF_8).size <= MAX_FRAME_BYTES)
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val token = "s3cret-token"
    val port = freePort()

    val serverSessions = AtomicInteger(0)
    val serverFrames = ConcurrentLinkedQueue<InboundFrame>()

    val server = BridgeServer(scope, StdLog("SRV"), TransportSettings(
        mode = WsMode.SERVER, token = token, clientId = "srv",
        serverHost = "127.0.0.1", serverPort = port,
    ))
    server.onSessionOpen = { s ->
        serverSessions.incrementAndGet()
        s.send(FrameCodec.encode(HelloFrame(clientId = "server-plugin", botId = 12345L)))
        // 模拟 Prayer：连上后向插件发一个 ping，期待 pong
        s.send("{\"v\":1,\"type\":\"ping\"}")
    }
    server.onFrame = { _, f -> serverFrames.add(f) }
    server.start()
    check("server 启动就绪", server.awaitStarted(5000))

    // ---- 1) 正确 token 建连 + hello 上行 ----
    val clientFrames = ConcurrentLinkedQueue<InboundFrame>()
    val clientA = BridgeClient(scope, StdLog("CLA"), clientSettings(port, token))
    clientA.onSessionOpen = { s ->
        // 插件始终先发 hello（模拟）
        s.send(FrameCodec.encode(HelloFrame(clientId = "test-client", botId = 12345L)))
    }
    clientA.onFrame = { s, f ->
        clientFrames.add(f)
        if (f.type == "ping") s.send(FrameCodec.encode(PongFrame())) // 回 pong
    }
    clientA.start()
    check("clientA 连接成功", waitUntil(6000) { clientA.isReady() })
    check("server 收到 1 个会话", waitUntil(3000) { serverSessions.get() == 1 })
    check("server 收到 hello 帧", waitUntil(3000) { serverFrames.any { it.type == "hello" } })
    check("client 收到 ping 帧", waitUntil(3000) { clientFrames.any { it.type == "ping" } })
    check("server 模式插件也能主动发 hello", clientFrames.any { it.type == "hello" })
    check("server 收到 pong 帧", waitUntil(3000) { serverFrames.any { it.type == "pong" } })

    // ---- 2) 单活动会话：重复连接被拒 ----
    val clientDup = BridgeClient(scope, StdLog("DUP"), clientSettings(port, token))
    clientDup.start()
    Thread.sleep(1500)
    check("重复连接未就绪(被拒)", !clientDup.isReady())
    check("server 仍只有 1 个活动会话", server.currentSession() != null && serverSessions.get() == 1)
    clientDup.stop()

    // ---- 3) 错误 token：握手层被拒 ----
    val clientBad = BridgeClient(scope, StdLog("BAD"), clientSettings(port, "wrong-token"))
    clientBad.start()
    Thread.sleep(1500)
    check("错误 token 未就绪(被拒)", !clientBad.isReady())
    clientBad.stop()

    val lateResponses = AtomicInteger(0)
    val pendingRequests = AtomicInteger(0)
    clientA.onFrame = { _, frame ->
        if (frame.type == "request") {
            pendingRequests.incrementAndGet()
            delay(500)
            lateResponses.incrementAndGet()
        }
    }
    val oldSession = server.currentSession()!!
    oldSession.send("{\"v\":1,\"type\":\"request\",\"echo\":\"slow\",\"action\":\"listChats\"}")
    check("异步查询已开始", waitUntil(3000) { pendingRequests.get() == 1 })

    // ---- 4) stop 幂等 + 有界 ----
    clientA.stop()
    clientA.stop() // 二次 stop 不应抛/挂
    check("client 二次 stop 幂等", true)
    check("server 感知客户端断开", waitUntil(3000) { server.currentSession() == null })
    Thread.sleep(600)
    check("旧会话异步任务已取消", lateResponses.get() == 0)
    check("旧会话不可发送到后继连接", !oldSession.send("{}"))

    // 原始 TCP 对端故意不完成 WS 握手，stop 必须仍关闭 socket。
    ServerSocket(0).use { rawServer ->
        rawServer.soTimeout = 3000
        val connecting = BridgeClient(scope, StdLog("WAIT"), clientSettings(rawServer.localPort, token))
        connecting.start()
        rawServer.accept().use { rawSocket ->
            rawSocket.soTimeout = 3000
            connecting.stop()
            val closed = try {
                val buffer = ByteArray(4096)
                while (rawSocket.getInputStream().read(buffer) != -1) { }
                true
            } catch (_: java.net.SocketTimeoutException) { false }
            check("握手中 stop 关闭 TCP 连接", closed)
            check("握手中 stop 后不可就绪", !connecting.isReady())
        }
    }

    val t0 = System.currentTimeMillis()
    server.stop()
    server.stop() // 二次 stop
    val cost = System.currentTimeMillis() - t0
    check("server stop 有界(<3s) 且幂等: ${cost}ms", cost < 3000)
    scope.cancel()

    println(if (failures == 0) "\nALL PASS" else "\n$failures CHECK(S) FAILED")
    // 显式退出：Java-WebSocket 与协程线程非 daemon，否则 JVM 不自动结束
    kotlin.system.exitProcess(if (failures == 0) 0 else 1)
}
