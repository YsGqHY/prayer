import type { ActionSend } from "../../core/chat/events"
import type { Channel, ChannelCapabilities, ChannelStatus } from "../../core/chat/types"
import { PROTOCOL_VERSION } from "./protocol"
import { MiraiWsClient, type MiraiClientOpts } from "./client"
import {
  MiraiWsServer,
  type MiraiServerOpts,
  type MiraiServerStats,
} from "./server"

const MIRAI_CAPABILITIES: ChannelCapabilities = {
  canNotifyOwnAdminSurface: true,
  supportsAdminCommands: true,
  // 成员/会话列表经 WS 回查插件
  supportsMemberList: true,
  supportsGroupList: true,
  // 图片由插件侧下载后 base64 回传,Prayer 不出网
  supportsMediaDownload: true,
  // mirai 提供可靠的群内角色,反思/归类/主动补位均可用
  supportsBypassPipeline: true,
}

/**
 * mirai 通道适配器：WS 两种建连方向复用同一套业务协议。
 */
export class MiraiChannel implements Channel {
  readonly id = "mirai" as const
  readonly capabilities = MIRAI_CAPABILITIES

  private server: MiraiWsServer | MiraiWsClient
  private mode: "server" | "client"
  private lastError?: string

  constructor(
    opts:
      | (MiraiServerOpts & { mode?: "server" })
      | (MiraiClientOpts & { mode: "client" })
  ) {
    this.mode = opts.mode ?? "server"
    this.server =
      opts.mode === "client" ? new MiraiWsClient(opts) : new MiraiWsServer(opts)
  }

  async start(): Promise<void> {
    this.lastError = undefined
    await this.server.start()
  }

  async stop(): Promise<void> {
    await this.server.stop()
  }

  isConnected(): boolean {
    return this.server.isConnected()
  }

  status(): ChannelStatus {
    return {
      id: this.id,
      connected: this.isConnected(),
      lastError: this.lastError ?? this.server.getLastError(),
      detail: [`mode=${this.mode}`, formatMiraiDetail(this.server.stats())]
        .filter(Boolean)
        .join(" "),
    }
  }

  setLastError(err: string): void {
    this.lastError = err
  }

  async send(action: ActionSend): Promise<void> {
    // 防御:仅本通道(registry 已过滤,双保险)
    if (action.channel !== "mirai") return
    this.server.send(action.chatId, {
      v: PROTOCOL_VERSION,
      type: "send",
      chatId: action.chatId,
      text: action.text,
      replyToId: action.replyToId,
    })
  }

  /**
   * 会话列表:优先用连接期已知路由(hello 上报),为空才回查插件。
   * 后台群组页每几秒轮询,不宜每次都打一轮 WS 往返。
   */
  async listChats(): Promise<{ id: string; name: string }[] | undefined> {
    const known = this.server.knownChats()
    if (known.length > 0) return known
    const raw = await this.server.request("listChats")
    if (!Array.isArray(raw)) return undefined
    return raw.map((c) => {
      const o = c as { id?: unknown; name?: unknown }
      const id = String(o.id ?? "")
      return { id, name: String(o.name ?? id) }
    })
  }

  async listMembers(chatId: string): Promise<unknown[] | undefined> {
    const raw = await this.server.request("listMembers", { chatId }, chatId)
    return Array.isArray(raw) ? raw : undefined
  }

  async resolveChatTitle(chatId: string): Promise<string | undefined> {
    const hit = this.server.knownChats().find((c) => c.id === chatId)
    return hit && hit.name !== chatId ? hit.name : undefined
  }
}

export { MiraiWsServer } from "./server"
export { MiraiWsClient } from "./client"

/**
 * 把服务端统计拼成状态页可读的 detail。
 * 全部缺省时返回 undefined,由调用方回落。
 */
export function formatMiraiDetail(
  stats: MiraiServerStats,
  now: number = Date.now()
): string | undefined {
  const parts: string[] = []
  if (stats.conns > 0) {
    parts.push(`conns=${stats.conns}/${stats.clients}`)
  }
  if (stats.chats > 0) parts.push(`chats=${stats.chats}`)
  if (stats.lastRxAt != null) {
    parts.push(`rx=${Math.round((now - stats.lastRxAt) / 1000)}s ago`)
  }
  if (stats.rejected > 0) parts.push(`rejected=${stats.rejected}`)
  return parts.length > 0 ? parts.join(" ") : undefined
}
