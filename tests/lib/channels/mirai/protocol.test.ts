import { describe, it, expect } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createHash } from "node:crypto"
import {
  parseInboundFrame,
  encodeFrame,
  PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
} from "@/lib/channels/mirai/protocol"

const helloRaw = JSON.stringify({
  v: 1,
  type: "hello",
  clientId: "mirai-1",
  botId: 10001,
  chats: [{ id: "123", name: "群甲" }],
})

describe("mirai 协议帧解析", () => {
  const kotlinFixtures = resolve("mirai-plugin/build/protocol-frames.json")
  it.skipIf(!existsSync(kotlinFixtures) && !process.env.MIRAI_REQUIRE_FIXTURES)(
    "真实 Kotlin 序列化结果符合 Prayer 入站协议（先运行 loopbackTest）",
    () => {
      const { frames, sourceHash }: { frames: unknown[]; sourceHash: string } =
        JSON.parse(readFileSync(kotlinFixtures, "utf8"))
      expect(sourceHash).toBe(
        createHash("sha256")
          .update(
            readFileSync(resolve("mirai-plugin/src/main/kotlin/Protocol.kt"))
          )
          .digest("hex")
      )
      expect(frames).toHaveLength(6)
      for (const frame of frames) {
        const parsed = parseInboundFrame(JSON.stringify(frame))
        expect(parsed.error).toBeUndefined()
        expect(parsed.frame).toBeDefined()
      }
    }
  )
  it("hello 帧解析出身份与会话", () => {
    const { frame, error } = parseInboundFrame(helloRaw)
    expect(error).toBeUndefined()
    expect(frame?.type).toBe("hello")
    if (frame?.type !== "hello") throw new Error("类型不符")
    expect(frame.clientId).toBe("mirai-1")
    expect(frame.botId).toBe(10001)
    expect(frame.chats).toEqual([{ id: "123", name: "群甲" }])
  })

  it("message 帧:缺省字段取默认值", () => {
    const raw = JSON.stringify({
      v: 1,
      type: "message",
      messageId: "m-1",
      chatId: "123",
      userId: "456",
    })
    const { frame } = parseInboundFrame(raw)
    if (frame?.type !== "message") throw new Error("类型不符")
    expect(frame.text).toBe("")
    expect(frame.botMentioned).toBe(false)
    expect(frame.images).toBeUndefined()
  })

  it("message 帧:完整字段", () => {
    const raw = JSON.stringify({
      v: 1,
      type: "message",
      messageId: "m-2",
      chatId: "123",
      userId: "456",
      senderRole: "admin",
      text: "怎么退款",
      botMentioned: true,
      quoted: "上一条",
      images: [{ data: "AAAA", mediaType: "image/png" }],
    })
    const { frame } = parseInboundFrame(raw)
    if (frame?.type !== "message") throw new Error("类型不符")
    expect(frame.senderRole).toBe("admin")
    expect(frame.botMentioned).toBe(true)
    expect(frame.images).toHaveLength(1)
  })

  // 对端是独立进程/独立语言栈,不能假定它守约:畸形输入只能返回 error,绝不抛异常
  it("非法 JSON 返回 error 而不抛", () => {
    const { frame, error } = parseInboundFrame("{ 不是 json")
    expect(frame).toBeUndefined()
    expect(error).toBe("非法 JSON")
  })

  it("未知 type 被拒绝", () => {
    const { frame, error } = parseInboundFrame(
      JSON.stringify({ v: 1, type: "evil" })
    )
    expect(frame).toBeUndefined()
    expect(error).toContain("帧校验失败")
  })

  it("缺必填字段被拒绝", () => {
    const { frame, error } = parseInboundFrame(
      JSON.stringify({ v: 1, type: "message", chatId: "1" })
    )
    expect(frame).toBeUndefined()
    expect(error).toContain("messageId")
  })

  it("版本不符被拒绝", () => {
    const { frame } = parseInboundFrame(JSON.stringify({ v: 99, type: "pong" }))
    expect(frame).toBeUndefined()
  })

  it("senderRole 只接受三个枚举值", () => {
    const bad = parseInboundFrame(
      JSON.stringify({
        v: 1,
        type: "message",
        messageId: "m",
        chatId: "1",
        userId: "2",
        senderRole: "root",
      })
    )
    expect(bad.frame).toBeUndefined()
  })

  it("超大帧被拒绝,不进 JSON.parse", () => {
    const huge = "x".repeat(MAX_FRAME_BYTES + 1)
    const { frame, error } = parseInboundFrame(huge)
    expect(frame).toBeUndefined()
    expect(error).toContain("帧过大")
  })

  it("null / 数组 / 基本类型不崩", () => {
    for (const raw of ["null", "[]", "42", '"str"', "true"]) {
      const { frame, error } = parseInboundFrame(raw)
      expect(frame).toBeUndefined()
      expect(error).toBeTruthy()
    }
  })

  it("encodeFrame 产出带版本号的 JSON", () => {
    const s = encodeFrame({
      v: PROTOCOL_VERSION,
      type: "send",
      chatId: "123",
      text: "hi",
      replyToId: "m-1",
    })
    expect(JSON.parse(s)).toEqual({
      v: 1,
      type: "send",
      chatId: "123",
      text: "hi",
      replyToId: "m-1",
    })
  })
})
