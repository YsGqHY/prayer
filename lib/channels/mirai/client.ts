import WebSocket from "ws"
import { MiraiWsPeer, type MiraiPeerOpts } from "./peer"
import { MAX_FRAME_BYTES } from "./protocol"

export interface MiraiClientOpts extends MiraiPeerOpts {
  url: string
  clientId: string
  token: string
  connectTimeoutMs?: number
  backoffMs?: number
  maxBackoffMs?: number
}

export class MiraiWsClient extends MiraiWsPeer {
  private socket?: WebSocket
  private retryTimer?: ReturnType<typeof setTimeout>
  private running = false
  private nextBackoff: number

  constructor(private readonly opts: MiraiClientOpts) {
    super(opts)
    this.nextBackoff = opts.backoffMs ?? 1000
  }

  async start(): Promise<void> {
    if (this.running) return
    let url: URL
    try {
      url = new URL(this.opts.url)
    } catch {
      throw new Error("Mirai WS 服务端地址无效")
    }
    if (
      !["ws:", "wss:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new Error(
        "Mirai 地址必须是 ws:// 或 wss://，不能包含认证信息或片段"
      )
    }
    if (!this.opts.token.trim() || !this.opts.clientId.trim()) {
      throw new Error("Mirai 客户端模式必须配置 token 和插件 clientId")
    }
    this.running = true
    this.nextBackoff = this.opts.backoffMs ?? 1000
    this.startPeer()
    this.connect()
  }

  private connect(): void {
    if (!this.running) return
    let socket: WebSocket
    try {
      socket = new WebSocket(this.opts.url, {
        headers: { Authorization: `Bearer ${this.opts.token}` },
        handshakeTimeout: this.opts.connectTimeoutMs ?? 10_000,
        maxPayload: MAX_FRAME_BYTES,
        followRedirects: false,
      })
    } catch {
      this.lastError = "无法创建 Mirai WS 连接，请检查地址和 token 格式"
      this.retry()
      return
    }
    this.socket = socket
    const disconnected = () => {
      if (this.socket !== socket) return
      this.socket = undefined
      if (this.running) {
        this.lastError ??= "Mirai WS 已断开，正在自动重连"
        this.retry()
      }
    }
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (this.socket !== socket || !this.running) return
      this.lastError =
        error.code === "ECONNREFUSED"
          ? "Mirai 服务端拒绝连接，请检查插件监听地址和端口"
          : error.code === "ENOTFOUND"
            ? "Mirai 服务端域名无法解析"
            : "Mirai WS 握手或连接失败，请检查 token、地址、TLS 证书及网络"
    })
    socket.on("close", disconnected)
    socket.on("open", () => {
      if (!this.running || this.socket !== socket) {
        socket.terminate()
        return
      }
      this.attach(socket, this.opts.clientId, {
        requireHello: true,
        onReady: () => {
          this.nextBackoff = this.opts.backoffMs ?? 1000
        },
        onDrop: disconnected,
      })
    })
  }

  private retry(): void {
    if (!this.running || this.retryTimer) return
    const delay = this.nextBackoff
    this.nextBackoff = Math.min(delay * 2, this.opts.maxBackoffMs ?? 60_000)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.connect()
    }, delay)
  }

  async stop(): Promise<void> {
    this.running = false
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    const socket = this.socket
    this.socket = undefined
    this.stopPeer()
    socket?.terminate()
  }
}
