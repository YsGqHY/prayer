package org.prayer.bridge

import net.mamoe.mirai.message.data.MessageSource

/**
 * messageId → MessageSource 缓存。
 *
 * 为什么必需：MessageSource 无法从 id 还原，而引用回复（QuoteReply）必须持有原始
 * MessageSource 对象。Prayer 侧回复时只带 replyToId（字符串），因此本地必须留档。
 *
 * 容量与时效都有上限：超时或超量即丢弃，此时降级为不引用的纯文本发送，
 * 不影响答复本身送达。
 */
class SourceCache(
    private val maxEntries: Int = 500,
    private val ttlMs: Long = 10 * 60_000,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private data class Entry(val source: MessageSource, val exp: Long)

    // LinkedHashMap 保序，超量时淘汰最早插入的
    private val map = LinkedHashMap<String, Entry>()

    @Synchronized
    fun put(id: String, source: MessageSource) {
        sweep()
        map.remove(id)
        map[id] = Entry(source, now() + ttlMs)
        while (map.size > maxEntries) {
            val oldest = map.keys.firstOrNull() ?: break
            map.remove(oldest)
        }
    }

    @Synchronized
    fun get(id: String): MessageSource? {
        val e = map[id] ?: return null
        if (e.exp <= now()) {
            map.remove(id)
            return null
        }
        return e.source
    }

    @Synchronized
    fun clear() = map.clear()

    @Synchronized
    fun size(): Int = map.size

    /** 摊还清理：每次 put 时顺带扫掉已过期项，避免长期只写不读的键堆积 */
    private fun sweep() {
        val t = now()
        val it = map.entries.iterator()
        var scanned = 0
        while (it.hasNext() && scanned < 20) {
            val e = it.next()
            if (e.value.exp <= t) it.remove()
            scanned++
        }
    }
}

/**
 * 由 MessageSource 生成稳定 messageId。
 *
 * ids 是数组（分片消息有多个），拼接后对同一条消息恒定，因此可用于 Prayer 侧去重。
 * 加 botId 与 fromId 前缀避免多账号下的极小概率碰撞。
 */
fun MessageSource.stableId(): String =
    "${botId}_${fromId}_${ids.joinToString("-")}"
