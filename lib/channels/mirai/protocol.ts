import { z } from "zod"

/**
 * mirai 桥接协议(v1)。建连方向可选；入站始终指插件发往 Prayer。
 *
 * 设计取舍:
 * - 入站帧全部经 zod 校验 —— 对端是独立进程/独立语言栈,不能假定它守约;
 *   非法帧只丢弃并记 warn,绝不允许崩掉服务端(会连带断掉其它 client)。
 * - 所有帧带 v,便于将来不兼容演进时并存两版。
 * - 图片走 base64 内联:插件侧已 queryUrl 下载,Prayer 侧不再出网。
 */
export const PROTOCOL_VERSION = 1

/** 单帧上限:图片 base64 会撑大体积,超限说明对端未按约束压缩 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024

const imageSchema = z.object({
  data: z.string().min(1),
  mediaType: z.string().min(1),
})

/** 群内角色:与 OneBot 对齐,供反思识别人工回复 */
const roleSchema = z.enum(["owner", "admin", "member"])

const chatSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(""),
})

/** 插件的连接后首帧：声明身份与所辖会话，Prayer 据此建路由。 */
export const helloFrameSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("hello"),
  clientId: z.string().min(1),
  botId: z.number().int().positive(),
  chats: z.array(chatSchema).default([]),
})

export const messageFrameSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("message"),
  /** 必须稳定:Prayer 侧据此去重,重连重放不应导致重复回答 */
  messageId: z.string().min(1),
  chatId: z.string().min(1),
  userId: z.string().min(1),
  senderRole: roleSchema.optional(),
  text: z.string().default(""),
  /** 消息链是否含 At(bot);由插件判定后显式上报,gateway 直接采信 */
  botMentioned: z.boolean().default(false),
  quoted: z.string().optional(),
  forwarded: z.string().optional(),
  images: z.array(imageSchema).optional(),
  ts: z.number().int().nonnegative().optional(),
})

/** 回查应答(对应服务端 request);data 形状由 action 决定,此处不窄化 */
export const responseFrameSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("response"),
  echo: z.string().min(1),
  data: z.unknown().optional(),
  error: z.string().optional(),
})

export const pongFrameSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("pong"),
})

export const inboundFrameSchema = z.discriminatedUnion("type", [
  helloFrameSchema,
  messageFrameSchema,
  responseFrameSchema,
  pongFrameSchema,
])

export type HelloFrame = z.output<typeof helloFrameSchema>
export type MessageFrame = z.output<typeof messageFrameSchema>
export type ResponseFrame = z.output<typeof responseFrameSchema>
export type InboundFrame = z.output<typeof inboundFrameSchema>

/** 出站:发群消息;replyToId 存在则引用回复 */
export interface SendFrame {
  v: typeof PROTOCOL_VERSION
  type: "send"
  chatId: string
  text: string
  replyToId?: string
}

/** 出站:回查请求,客户端须以同 echo 的 response 应答 */
export interface RequestFrame {
  v: typeof PROTOCOL_VERSION
  type: "request"
  echo: string
  action: "listChats" | "listMembers"
  params?: Record<string, unknown>
}

export interface PingFrame {
  v: typeof PROTOCOL_VERSION
  type: "ping"
}

export type OutboundFrame = SendFrame | RequestFrame | PingFrame

export interface ParseResult {
  frame?: InboundFrame
  error?: string
}

/**
 * 解析入站帧。任何异常都收敛成 error 字符串,调用方只丢弃该帧。
 * 不抛异常:一个畸形帧不应影响连接与其它 client。
 */
export function parseInboundFrame(raw: string): ParseResult {
  const bytes = Buffer.byteLength(raw, "utf8")
  if (bytes > MAX_FRAME_BYTES) {
    return { error: `帧过大(${bytes} > ${MAX_FRAME_BYTES})` }
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { error: "非法 JSON" }
  }
  const parsed = inboundFrameSchema.safeParse(json)
  if (!parsed.success) {
    // 只取首个 issue:完整 issues 可能很长,日志无需刷屏
    const first = parsed.error.issues[0]
    const path = first?.path.join(".") || "(root)"
    return { error: `帧校验失败 ${path}: ${first?.message ?? "unknown"}` }
  }
  return { frame: parsed.data }
}

export function encodeFrame(frame: OutboundFrame): string {
  return JSON.stringify(frame)
}
