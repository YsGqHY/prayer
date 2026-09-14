package org.prayer.bridge

import kotlinx.coroutines.delay
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.encodeToJsonElement
import net.mamoe.mirai.Bot
import net.mamoe.mirai.console.plugin.jvm.JvmPluginDescription
import net.mamoe.mirai.console.plugin.jvm.KotlinPlugin
import net.mamoe.mirai.contact.MemberPermission
import net.mamoe.mirai.event.events.GroupMessageEvent
import net.mamoe.mirai.event.globalEventChannel
import net.mamoe.mirai.message.data.*
import net.mamoe.mirai.utils.MiraiExperimentalApi
import net.mamoe.mirai.utils.info
import net.mamoe.mirai.utils.warning
import java.util.concurrent.atomic.AtomicReference

object PrayerBridge : KotlinPlugin(
    JvmPluginDescription(
        id = "org.prayer.prayer-bridge",
        name = "Prayer Bridge",
        version = "0.1.0",
    ) {
        author("prayer")
        info("把群消息转发到远程 Prayer 客服中台，并把答复发回群里")
    }
) {
    /** 等待已登录 Bot 的上限：超时则关闭会话等重连，绝不上报 botId=0。 */
    private const val BOT_WAIT_MS = 120_000L

    private val sources = SourceCache()
    private lateinit var transport: BridgeTransport
    private lateinit var settings: TransportSettings

    /**
     * 当前「就绪」会话：仅在 hello 成功发出后置位（hello 先于 ready）。
     * forward/response 都只认它，从而保证任何出站都在身份声明之后。
     */
    private val readySession = AtomicReference<BridgeSession?>(null)
    private val sessionLock = Any()

    override fun onEnable() {
        BridgeConfig.reload()
        try {
            settings = BridgeConfig.toTransportSettings()
        } catch (e: IllegalArgumentException) {
            logger.warning("Prayer Bridge 配置无效，未启动: ${e.message}")
            return
        }
        logger.info { "Prayer Bridge 启动，mode=${settings.mode} clientId=${settings.clientId}" }

        val log = MiraiBridgeLog(logger)
        transport = when (settings.mode) {
            WsMode.CLIENT -> BridgeClient(this, log, settings)
            WsMode.SERVER -> BridgeServer(this, log, settings)
        }
        transport.onSessionOpen = ::onSessionOpen
        transport.onFrame = ::handleInbound
        transport.onSessionClose = ::onSessionClose
        transport.start()

        // 必须用 globalEventChannel()（= GlobalEventChannel.parentScope(this)）：
        // 裸用 GlobalEventChannel 在插件停用后监听器不会解绑
        globalEventChannel().subscribeAlways<GroupMessageEvent> { event ->
            try {
                forward(event)
            } catch (e: Exception) {
                logger.warning("转发失败 group=${event.group.id}: ${e.message}")
            }
        }
    }

    override fun onDisable() {
        if (::transport.isInitialized) transport.stop()
        readySession.set(null)
        sources.clear()
        logger.info { "Prayer Bridge 已停止" }
    }

    /**
     * 会话确立：插件始终先发 hello（无论 client / server），成功后才置就绪。
     * 无已登录 Bot 时不发 botId=0，而是有界可取消地等待；超时则关闭会话等重连。
     */
    private suspend fun onSessionOpen(session: BridgeSession) {
        val bot = awaitBot(session)
        if (bot == null) {
            if (session.isOpen()) {
                logger.warning("等待 Bot 超时，关闭会话等待重连（不上报 botId=0）")
                session.close()
            }
            return
        }
        val chats = bot.groups
            .filter { allowed(it.id) }
            .map { ChatDto(id = it.id.toString(), name = it.name) }
        synchronized(sessionLock) {
            if (!session.isOpen() || transport.currentSession() !== session) return
            val ok = session.send(
                FrameCodec.encode(
                    HelloFrame(clientId = settings.clientId, botId = bot.id, chats = chats)
                )
            )
            if (ok && session.isOpen()) {
                readySession.set(session)
                logger.info { "已上报 ${chats.size} 个会话 (botId=${bot.id})" }
            } else {
                session.close()
                logger.warning("hello 发送失败，等待重连")
            }
        }
    }

    private suspend fun onSessionClose(session: BridgeSession) {
        // 只清理属于本会话的就绪标记，避免误清后继会话
        synchronized(sessionLock) { readySession.compareAndSet(session, null) }
    }

    /** 轮询等待一个可用 Bot；会话关闭或超时即放弃返回 null。 */
    private suspend fun awaitBot(session: BridgeSession): Bot? {
        val deadline = System.currentTimeMillis() + BOT_WAIT_MS
        while (session.isOpen() && System.currentTimeMillis() < deadline) {
            val bot = Bot.instancesSequence.firstOrNull { it.isOnline }
            if (bot != null) return bot
            delay(500)
        }
        return null
    }
    private fun allowed(groupId: Long): Boolean {
        val list = BridgeConfig.allowedGroups
        return list.isEmpty() || list.contains(groupId)
    }

    @OptIn(MiraiExperimentalApi::class)
    private suspend fun forward(event: GroupMessageEvent) {
        if (!allowed(event.group.id)) return
        // 只在就绪会话（hello 已发）上转发；未就绪直接丢弃，不静默走裸连接
        val session = readySession.get()?.takeIf { it.isOpen() } ?: return

        val chain = event.message
        val source = chain[MessageSource]
        val messageId = source?.stableId() ?: return
        // 留档供引用回复：Prayer 侧只回传 replyToId 字符串，本地必须持有原对象
        sources.put(messageId, source)

        val role = when (event.sender.permission) {
            MemberPermission.OWNER -> "owner"
            MemberPermission.ADMINISTRATOR -> "admin"
            MemberPermission.MEMBER -> "member"
        }
        val botMentioned = chain.any { it is At && it.target == event.bot.id }
        val quoted = chain[QuoteReply]?.source?.originalMessage?.content

        val images = if (BridgeConfig.forwardImages) {
            chain.filterIsInstance<Image>()
                .take(BridgeConfig.maxImagesPerMessage.coerceAtLeast(0))
                .mapNotNull { img ->
                    try {
                        // queryUrl 是 Image.Key 上的 suspend 成员扩展,
                        // 需把 Key 带入作用域才能调用(不是顶层扩展)
                        val url = with(Image.Key) { img.queryUrl() }
                        val bytes = HttpDownloader.get(url) ?: return@mapNotNull null
                        ImageDto(
                            data = java.util.Base64.getEncoder().encodeToString(bytes),
                            mediaType = guessMediaType(url),
                        )
                    } catch (e: Exception) {
                        logger.warning("图片下载失败: ${e.message}")
                        null
                    }
                }
                .takeIf { it.isNotEmpty() }
        } else null

        session.send(
            FrameCodec.encode(
                MessageFrame(
                    messageId = messageId,
                    chatId = event.group.id.toString(),
                    userId = event.sender.id.toString(),
                    senderRole = role,
                    text = chain.content,
                    botMentioned = botMentioned,
                    quoted = quoted,
                    images = images,
                    ts = event.time.toLong() * 1000,
                )
            )
        )
    }
    private suspend fun handleInbound(session: BridgeSession, frame: InboundFrame) {
        if (!session.isOpen() || transport.currentSession() !== session) return
        if (frame.type != "ping" && readySession.get() !== session) return
        when (frame.type) {
            "send" -> doSend(frame)
            // response 必须绑回收到 request 的原会话，断线后新会话不该收到旧应答
            "request" -> doRequest(session, frame)
            "ping" -> session.send(FrameCodec.encode(PongFrame()))
            else -> logger.warning("未知帧类型: ${frame.type}")
        }
    }

    private suspend fun doSend(frame: InboundFrame) {
        val chatId = frame.chatId?.toLongOrNull() ?: return
        val text = frame.text ?: return
        // 多账号安全：优先按持有该群的 Bot 找，避免固定取第一个实例发错群
        val bot = Bot.instancesSequence.firstOrNull { it.getGroup(chatId) != null }
            ?: Bot.instancesSequence.firstOrNull()
            ?: return
        val group = bot.getGroup(chatId) ?: run {
            logger.warning("Bot ${bot.id} 不在群 $chatId 中，丢弃出站消息")
            return
        }
        val quote = frame.replyToId?.let { sources.get(it) }
        try {
            if (quote != null) {
                group.sendMessage(QuoteReply(quote) + PlainText(text))
            } else {
                group.sendMessage(text)
            }
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            logger.warning("发送群消息失败 group=$chatId: ${e.message}")
        }
    }

    private suspend fun doRequest(session: BridgeSession, frame: InboundFrame) {
        val echo = frame.echo ?: return
        when (frame.action) {
            "listChats" -> {
                val bot = Bot.instancesSequence.firstOrNull()
                val chats = bot?.groups?.filter { allowed(it.id) }
                    ?.map { ChatDto(it.id.toString(), it.name) } ?: emptyList()
                session.send(
                    FrameCodec.encode(
                        ResponseFrame(echo = echo, data = FrameCodec.json.encodeToJsonElement(chats))
                    )
                )
            }
            "listMembers" -> {
                val gid = frame.params?.get("chatId")?.toLongOrNull()
                val bot = gid?.let { g ->
                    Bot.instancesSequence.firstOrNull { it.getGroup(g) != null }
                }
                val members = gid?.let { g ->
                    bot?.getGroup(g)?.members?.map { m ->
                        MemberDto(
                            userId = m.id,
                            nickname = m.nick,
                            card = m.nameCard,
                            role = when (m.permission) {
                                MemberPermission.OWNER -> "owner"
                                MemberPermission.ADMINISTRATOR -> "admin"
                                MemberPermission.MEMBER -> "member"
                            },
                        )
                    }
                } ?: emptyList()
                session.send(
                    FrameCodec.encode(
                        ResponseFrame(echo = echo, data = FrameCodec.json.encodeToJsonElement(members))
                    )
                )
            }
            else -> session.send(
                FrameCodec.encode(
                    ResponseFrame(echo = echo, error = "unsupported action: ${frame.action}")
                )
            )
        }
    }

    private fun guessMediaType(url: String): String {
        val path = url.substringBefore('?').lowercase()
        return when {
            path.endsWith(".png") -> "image/png"
            path.endsWith(".gif") -> "image/gif"
            path.endsWith(".webp") -> "image/webp"
            else -> "image/jpeg"
        }
    }
}

/** MiraiLogger → BridgeLog 适配。传输层不感知 mirai。 */
private class MiraiBridgeLog(private val logger: net.mamoe.mirai.utils.MiraiLogger) : BridgeLog {
    override fun info(msg: String) = logger.info(msg)
    override fun warn(msg: String) = logger.warning(msg)
    override fun error(msg: String) = logger.error(msg)
}
