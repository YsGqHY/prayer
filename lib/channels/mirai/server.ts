import { WebSocketServer } from "ws"
import type { IncomingMessage as HttpRequest } from "node:http"
import { logger } from "../../logger"
import { timingSafeEqualStr } from "../../auth"
import { MiraiWsPeer, type MiraiPeerOpts } from "./peer"
import { MAX_FRAME_BYTES } from "./protocol"

export {
  PING_INTERVAL_MS,
  LIVENESS_MS,
  REQUEST_TIMEOUT_MS,
  type MiraiServerStats,
} from "./peer"

export interface MiraiServerOpts extends MiraiPeerOpts {
  port: number
  clients: Record<string, string>
}

/** 独立端口监听，保留 next start 的部署方式。业务处理与主动连接共用。 */
export class MiraiWsServer extends MiraiWsPeer {
  private wss?: WebSocketServer

  constructor(private readonly opts: MiraiServerOpts) {
    super(opts)
  }

  async start(): Promise<void> {
    if (this.wss) return
    this.lastError = undefined
    const entries = Object.entries(this.opts.clients).filter(
      ([id, token]) => id.trim() && token.trim()
    )
    if (!entries.length)
      throw new Error("未配置任何 mirai 接入凭据，拒绝启动 WS 服务端")
    const credentials = new Map(entries)
    await new Promise<void>((resolve, reject) => {
      const wss = new WebSocketServer({
        port: this.opts.port,
        maxPayload: MAX_FRAME_BYTES,
        verifyClient: (info, done) => {
          const clientId = this.authenticate(info.req, credentials)
          if (!clientId) {
            this.rejected++
            done(false, 401, "Unauthorized")
            return
          }
          ;(info.req as HttpRequest & { clientId: string }).clientId = clientId
          done(true)
        },
      })
      this.wss = wss
      wss.on("connection", (ws, req) => {
        this.attach(ws, (req as HttpRequest & { clientId: string }).clientId, {
          requireHello: true,
        })
      })
      wss.on("error", (error) => {
        this.lastError = error.message
        logger.log("error", `[mirai] WS 服务端错误: ${this.lastError}`)
        reject(error)
      })
      wss.on("listening", resolve)
    })
    this.startPeer()
  }

  private authenticate(
    req: HttpRequest,
    credentials: Map<string, string>
  ): string | null {
    const auth = req.headers.authorization
    let token =
      typeof auth === "string" && auth.startsWith("Bearer ")
        ? auth.slice(7).trim()
        : ""
    if (!token) {
      const raw = req.headers["sec-websocket-protocol"] ?? ""
      token =
        raw
          .split(",")
          .map((part) => part.trim())
          .find((part) => part.startsWith("prayer."))
          ?.slice(7) ?? ""
    }
    if (!token) return null
    let match: string | null = null
    for (const [id, expected] of credentials) {
      if (timingSafeEqualStr(token, expected)) match = id
    }
    return match
  }

  async stop(): Promise<void> {
    this.stopPeer()
    const wss = this.wss
    this.wss = undefined
    if (wss) {
      // 包括已升级但尚未进入业务会话的连接；避免等待关闭握手阻塞模式切换。
      for (const ws of wss.clients) ws.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
  }
}
