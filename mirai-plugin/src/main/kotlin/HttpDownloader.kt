package org.prayer.bridge

import java.net.HttpURLConnection
import java.net.URL

/**
 * 图片下载器。用 JDK 自带 HttpURLConnection 而非再引 HTTP 客户端：
 * mirai-console 有 classloader 隔离，插件多引一个网络库就多一份冲突风险。
 *
 * 只用于下载 QQ 图床返回的 URL（由 Image.queryUrl() 给出），不接受任意外部输入。
 */
object HttpDownloader {
    private const val TIMEOUT_MS = 15_000
    /** 单图上限 5MB：再大对模型没有意义，且会把 WS 帧撑爆（服务端限 8MB） */
    private const val MAX_BYTES = 5 * 1024 * 1024

    fun get(url: String): ByteArray? {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = TIMEOUT_MS
                readTimeout = TIMEOUT_MS
                requestMethod = "GET"
                instanceFollowRedirects = true
            }
            if (conn.responseCode !in 200..299) return null
            val len = conn.contentLengthLong
            if (len > MAX_BYTES) return null
            conn.inputStream.use { input ->
                val out = java.io.ByteArrayOutputStream()
                val buf = ByteArray(8192)
                var total = 0
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    total += n
                    // 边读边判：Content-Length 可能缺失或撒谎
                    if (total > MAX_BYTES) return null
                    out.write(buf, 0, n)
                }
                out.toByteArray()
            }
        } catch (_: Exception) {
            null
        } finally {
            conn?.disconnect()
        }
    }
}
