import WebSocket from "ws"
import { bus } from "../../core/bus"
import { logger } from "../../core/logger"
import {
  encodeFrame,
  parseInboundFrame,
  PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  type OutboundFrame,
} from "./protocol"

export const PING_INTERVAL_MS = 30_000
export const LIVENESS_MS = 75_000
export const REQUEST_TIMEOUT_MS = 10_000

export interface MiraiPeerOpts {
  onStatus?: (connected: boolean) => void
  pingIntervalMs?: number
  livenessMs?: number
  helloTimeoutMs?: number
  requestTimeoutMs?: number
}

export interface MiraiServerStats {
  clients: number
  conns: number
  chats: number
  lastRxAt?: number
  rejected: number
}

interface Connection {
  ws: WebSocket
  clientId: string
  ready: boolean
  lastRxAt: number
  helloTimer?: ReturnType<typeof setTimeout>
  onReady?: () => void
  onDrop?: () => void
}

interface Pending {
  targets: Set<Connection>
  resolve: (value: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

/** WS 建连方向与业务帧方向分离，两种传输共用路由、查询与清理。 */
export class MiraiWsPeer {
  private conns = new Set<Connection>()
  private routes = new Map<string, string>()
  private chatNames = new Map<string, string>()
  private pending = new Map<string, Pending>()
  private echoSeq = 0
  private timer?: ReturnType<typeof setInterval>
  private lastRxAt?: number
  protected lastError?: string
  protected rejected = 0

  constructor(protected readonly peerOpts: MiraiPeerOpts) {}

  isConnected(): boolean {
    return [...this.conns].some(
      (conn) => conn.ready && conn.ws.readyState === WebSocket.OPEN
    )
  }

  getLastError(): string | undefined {
    return this.lastError
  }

  stats(): MiraiServerStats {
    const ready = [...this.conns].filter((conn) => conn.ready)
    return {
      clients: new Set(ready.map((conn) => conn.clientId)).size,
      conns: ready.length,
      chats: this.routes.size,
      lastRxAt: this.lastRxAt,
      rejected: this.rejected,
    }
  }

  knownChats(): { id: string; name: string }[] {
    return [...this.routes.keys()].map((id) => ({
      id,
      name: this.chatNames.get(id) || id,
    }))
  }

  protected startPeer(): void {
    this.lastError = undefined
    if (!this.timer) {
      this.timer = setInterval(
        () => this.sweep(),
        this.peerOpts.pingIntervalMs ?? PING_INTERVAL_MS
      )
    }
  }

  protected attach(
    ws: WebSocket,
    clientId: string,
    hooks: {
      requireHello?: boolean
      onReady?: () => void
      onDrop?: () => void
    } = {}
  ): void {
    const conn: Connection = {
      ws,
      clientId,
      ready: !hooks.requireHello,
      lastRxAt: Date.now(),
      ...hooks,
    }
    this.conns.add(conn)
    if (hooks.requireHello) {
      conn.helloTimer = setTimeout(() => {
        this.lastError =
          "等待 Mirai hello 超时，请确认插件已登录 Bot 且 clientId 一致"
        this.drop(conn)
      }, this.peerOpts.helloTimeoutMs ?? REQUEST_TIMEOUT_MS)
    } else {
      this.peerOpts.onStatus?.(true)
    }
    ws.on("message", (data) => {
      if (!this.conns.has(conn)) return
      conn.lastRxAt = Date.now()
      this.lastRxAt = conn.lastRxAt
      this.onFrame(conn, String(data))
    })
    ws.on("pong", () => {
      conn.lastRxAt = Date.now()
    })
    ws.on("close", () => this.drop(conn))
    ws.on("error", () => this.drop(conn))
  }

  private drop(conn: Connection): void {
    if (!this.conns.delete(conn)) return
    clearTimeout(conn.helloTimer)
    conn.ws.terminate()
    for (const [echo, pending] of this.pending) {
      pending.targets.delete(conn)
      if (pending.targets.size === 0) this.settle(echo, undefined)
    }
    if (
      ![...this.conns].some(
        (other) => other.clientId === conn.clientId && other.ready
      )
    ) {
      for (const [id, owner] of this.routes) {
        if (owner === conn.clientId) {
          this.routes.delete(id)
          this.chatNames.delete(id)
        }
      }
    }
    this.peerOpts.onStatus?.(this.isConnected())
    conn.onDrop?.()
  }

  private onFrame(conn: Connection, raw: string): void {
    const { frame, error } = parseInboundFrame(raw)
    if (!frame) {
      logger.log("warn", `[mirai] 帧丢弃: ${error}`)
      return
    }
    if (frame.type === "hello") {
      if (frame.clientId !== conn.clientId) {
        this.lastError = "Mirai hello 的 clientId 与配置或接入凭据不一致"
        this.rejected++
        this.drop(conn)
        return
      }
      clearTimeout(conn.helloTimer)
      const wasReady = conn.ready
      conn.ready = true
      this.lastError = undefined
      // 重连以最新且已验证的 hello 为准，同一插件不能重复接收出站命令。
      for (const previous of this.conns) {
        if (previous !== conn && previous.clientId === conn.clientId)
          this.drop(previous)
      }
      for (const [id, owner] of this.routes) {
        if (owner === conn.clientId) {
          this.routes.delete(id)
          this.chatNames.delete(id)
        }
      }
      for (const chat of frame.chats) {
        this.routes.set(chat.id, conn.clientId)
        if (chat.name) this.chatNames.set(chat.id, chat.name)
      }
      if (!wasReady) {
        this.peerOpts.onStatus?.(true)
        conn.onReady?.()
      }
      return
    }
    if (!conn.ready) return
    if (frame.type === "message") {
      if (!this.routes.has(frame.chatId))
        this.routes.set(frame.chatId, conn.clientId)
      bus.emit("message.received", {
        channel: "mirai",
        chatId: frame.chatId,
        userId: frame.userId,
        messageId: frame.messageId,
        rawText: frame.text,
        atList: [],
        botMentioned: frame.botMentioned,
        senderRole: frame.senderRole,
        images: frame.images,
        quoted: frame.quoted,
        forwarded: frame.forwarded,
      })
    } else if (
      frame.type === "response" &&
      this.pending.get(frame.echo)?.targets.has(conn)
    ) {
      this.settle(frame.echo, frame.error ? undefined : frame.data)
    }
  }

  private targets(chatId: string): Connection[] {
    const owner = this.routes.get(chatId)
    return [...this.conns].filter(
      (conn) =>
        conn.ready &&
        conn.ws.readyState === WebSocket.OPEN &&
        (!owner || conn.clientId === owner)
    )
  }

  private transmit(targets: Connection[], frame: OutboundFrame): boolean {
    const payload = encodeFrame(frame)
    if (Buffer.byteLength(payload, "utf8") > MAX_FRAME_BYTES) {
      logger.log("warn", "[mirai] 出站帧超过 8MiB，已拒绝发送")
      return false
    }
    let sent = false
    for (const conn of targets) {
      try {
        conn.ws.send(payload, (error) => {
          if (error) this.drop(conn)
        })
        sent = true
      } catch {
        this.drop(conn)
      }
    }
    return sent
  }

  send(chatId: string, frame: OutboundFrame): boolean {
    return this.transmit(this.targets(chatId), frame)
  }

  async request(
    action: "listChats" | "listMembers",
    params?: Record<string, unknown>,
    chatId?: string
  ): Promise<unknown> {
    const targets = this.targets(chatId ?? [...this.routes.keys()][0] ?? "")
    if (!targets.length) return undefined
    const echo = `req-${++this.echoSeq}`
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.settle(echo, undefined),
        this.peerOpts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
      )
      this.pending.set(echo, { targets: new Set(targets), resolve, timer })
      if (
        !this.transmit(targets, {
          v: PROTOCOL_VERSION,
          type: "request",
          echo,
          action,
          params,
        })
      ) {
        this.settle(echo, undefined)
      }
    })
  }

  private settle(echo: string, value: unknown): void {
    const pending = this.pending.get(echo)
    if (!pending) return
    this.pending.delete(echo)
    clearTimeout(pending.timer)
    pending.resolve(value)
  }

  private sweep(): void {
    const now = Date.now()
    for (const conn of this.conns) {
      if (now - conn.lastRxAt > (this.peerOpts.livenessMs ?? LIVENESS_MS)) {
        this.lastError = "Mirai 连接心跳超时，等待重新连接"
        this.drop(conn)
      } else if (conn.ready && conn.ws.readyState === WebSocket.OPEN) {
        this.transmit([conn], { v: PROTOCOL_VERSION, type: "ping" })
      }
    }
  }

  protected stopPeer(): void {
    clearInterval(this.timer)
    this.timer = undefined
    for (const conn of this.conns) this.drop(conn)
    for (const echo of this.pending.keys()) this.settle(echo, undefined)
    this.routes.clear()
    this.chatNames.clear()
    this.peerOpts.onStatus?.(false)
  }
}
