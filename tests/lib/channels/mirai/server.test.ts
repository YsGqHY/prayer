import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import WebSocket from "ws"
import { bus } from "@/lib/bus"
import { MiraiWsServer } from "@/lib/channels/mirai/server"
import { PROTOCOL_VERSION } from "@/lib/channels/mirai/protocol"
import type { IncomingMessage } from "@/lib/events"

let server: MiraiWsServer | undefined
let port = 0

// 端口 0 让内核分配,避免与本机既有服务冲突
async function startServer(
  clients: Record<string, string>,
  opts: { pingIntervalMs?: number; livenessMs?: number } = {}
): Promise<MiraiWsServer> {
  const s = new MiraiWsServer({ port: 0, clients, ...opts })
  await s.start()
  // 从内部 wss 取实到端口
  const wss = (s as unknown as { wss?: { address(): { port: number } } }).wss
  port = wss!.address().port
  return s
}

function connect(
  token: string | undefined,
  useSubprotocol = false
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}`
    const ws =
      useSubprotocol && token
        ? new WebSocket(url, [`prayer.${token}`])
        : new WebSocket(
            url,
            token ? { headers: { Authorization: `Bearer ${token}` } } : {}
          )
    ws.on("open", () => resolve(ws))
    ws.on("error", (e) => reject(e))
    ws.on("unexpected-response", (_req, res) =>
      reject(new Error(`HTTP ${res.statusCode}`))
    )
  })
}

const helloFrame = (clientId: string, chats: { id: string; name: string }[]) =>
  JSON.stringify({
    v: PROTOCOL_VERSION,
    type: "hello",
    clientId,
    botId: 10001,
    chats,
  })

// bus 是 globalThis 单例,removeAllListeners 会连带掐掉并行测试文件注册的监听器
// (vitest 默认多文件并发)。只摘自己挂的那个 handler,不动全局。
const listeners: ((m: IncomingMessage) => void)[] = []
function onMessage(fn: (m: IncomingMessage) => void): void {
  listeners.push(fn)
  bus.on("message.received", fn)
}

beforeEach(() => {
  listeners.length = 0
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  for (const fn of listeners) bus.off("message.received", fn)
  listeners.length = 0
})

describe("MiraiWsServer 鉴权", () => {
  it("无凭据配置 → 拒绝启动(不开放无鉴权端口)", async () => {
    const s = new MiraiWsServer({ port: 0, clients: {} })
    await expect(s.start()).rejects.toThrow(/拒绝启动/)
  })

  it("空白 clientId / token 视为无凭据", async () => {
    const s = new MiraiWsServer({ port: 0, clients: { "  ": "  " } })
    await expect(s.start()).rejects.toThrow(/拒绝启动/)
  })

  it("正确 token(header)可连接", async () => {
    server = await startServer({ "mirai-1": "secret-token" })
    const ws = await connect("secret-token")
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  it("正确 token(子协议)可连接", async () => {
    server = await startServer({ "mirai-1": "secret-token" })
    const ws = await connect("secret-token", true)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  it("错误 token 握手被拒(401)", async () => {
    server = await startServer({ "mirai-1": "secret-token" })
    await expect(connect("wrong-token")).rejects.toThrow(/401/)
    expect(server.stats().rejected).toBeGreaterThan(0)
  })

  it("无 token 握手被拒", async () => {
    server = await startServer({ "mirai-1": "secret-token" })
    await expect(connect(undefined)).rejects.toThrow(/401/)
  })

  it("被拒连接不计入 connected", async () => {
    server = await startServer({ "mirai-1": "secret-token" })
    await connect("bad").catch(() => {})
    expect(server.isConnected()).toBe(false)
  })
})

describe("MiraiWsServer 入站", () => {
  it("hello 冒用其他 clientId 不得建立路由", async () => {
    server = await startServer({ a: "token-aaaa1111", b: "token-bbbb2222" })
    const ws = await connect("token-aaaa1111")
    ws.send(helloFrame("b", [{ id: "123", name: "spoofed" }]))
    await vi.waitUntil(() => server!.stats().rejected === 1)
    expect(server.knownChats()).toEqual([])
    expect(server.isConnected()).toBe(false)
  })

  it("查询响应只能由收到请求的原连接完成", async () => {
    server = await startServer({ a: "token-aaaa1111", b: "token-bbbb2222" })
    const a = await connect("token-aaaa1111")
    const b = await connect("token-bbbb2222")
    a.send(helloFrame("a", [{ id: "123", name: "A" }]))
    b.send(helloFrame("b", [{ id: "456", name: "B" }]))
    await vi.waitUntil(() => server!.stats().chats === 2)
    const echoes: string[] = []
    a.on("message", (raw) => {
      const frame = JSON.parse(String(raw))
      if (frame.type === "request") echoes.push(frame.echo)
    })
    let settled = false
    const pending = server
      .request("listMembers", { chatId: "123" }, "123")
      .then((value) => {
        settled = true
        return value
      })
    await vi.waitUntil(() => echoes.length === 1)
    b.send(
      JSON.stringify({ v: 1, type: "response", echo: echoes[0], data: "wrong" })
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(settled).toBe(false)
    a.send(
      JSON.stringify({
        v: 1,
        type: "response",
        echo: echoes[0],
        data: "correct",
      })
    )
    expect(await pending).toBe("correct")
  })
  it("message 帧 → bus.emit message.received,字段完整映射", async () => {
    server = await startServer({ "mirai-1": "tok-12345678" })
    const got: IncomingMessage[] = []
    onMessage((m) => got.push(m))

    const ws = await connect("tok-12345678")
    ws.send(helloFrame("mirai-1", [{ id: "123", name: "群甲" }]))
    ws.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "message",
        messageId: "m-1",
        chatId: "123",
        userId: "456",
        senderRole: "member",
        text: "怎么退款",
        botMentioned: true,
      })
    )
    await vi.waitUntil(() => got.length > 0, { timeout: 2000 })

    expect(got[0]).toMatchObject({
      channel: "mirai",
      chatId: "123",
      userId: "456",
      messageId: "m-1",
      rawText: "怎么退款",
      botMentioned: true,
      senderRole: "member",
    })
    ws.close()
  })

  it("畸形帧不崩服务端,后续正常帧仍处理", async () => {
    server = await startServer({ "mirai-1": "tok-12345678" })
    const got: IncomingMessage[] = []
    onMessage((m) => got.push(m))

    const ws = await connect("tok-12345678")
    ws.send("{ 坏帧")
    ws.send(JSON.stringify({ v: 1, type: "unknown" }))
    ws.send(helloFrame("mirai-1", []))
    ws.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "message",
        messageId: "m-2",
        chatId: "123",
        userId: "456",
      })
    )
    await vi.waitUntil(() => got.length > 0, { timeout: 2000 })
    expect(got[0].messageId).toBe("m-2")
    expect(server.isConnected()).toBe(true)
    ws.close()
  })

  it("hello 建立会话路由,knownChats 可见", async () => {
    server = await startServer({ "mirai-1": "tok-12345678" })
    const ws = await connect("tok-12345678")
    ws.send(
      helloFrame("mirai-1", [
        { id: "123", name: "群甲" },
        { id: "456", name: "群乙" },
      ])
    )
    await vi.waitUntil(() => server!.stats().chats === 2, { timeout: 2000 })
    expect(server.knownChats()).toEqual([
      { id: "123", name: "群甲" },
      { id: "456", name: "群乙" },
    ])
    ws.close()
  })
})

describe("MiraiWsServer 出站路由", () => {
  it("同 clientId 重连替换旧连接，一次回复仅下发到新连接", async () => {
    server = await startServer({ a: "token-aaaa1111" })
    const old = await connect("token-aaaa1111")
    const receivedOld: string[] = []
    const receivedNew: string[] = []
    old.on("message", (data) => receivedOld.push(String(data)))
    old.send(helloFrame("a", [{ id: "123", name: "Old" }]))
    await vi.waitUntil(() => server!.stats().chats === 1)
    const fresh = await connect("token-aaaa1111")
    fresh.on("message", (data) => receivedNew.push(String(data)))
    fresh.send(helloFrame("a", [{ id: "123", name: "New" }]))
    await vi.waitUntil(() => old.readyState === WebSocket.CLOSED)
    expect(server.stats().conns).toBe(1)
    expect(server.knownChats()).toEqual([{ id: "123", name: "New" }])
    server.send("123", { v: 1, type: "send", chatId: "123", text: "once" })
    await vi.waitUntil(() => receivedNew.length === 1)
    expect(receivedOld).toEqual([])
  })

  it("出站也拒绝超过 8MiB 的帧", async () => {
    server = await startServer({ a: "token-aaaa1111" })
    const ws = await connect("token-aaaa1111")
    ws.send(helloFrame("a", [{ id: "123", name: "A" }]))
    await vi.waitUntil(() => server!.isConnected())
    expect(
      server.send("123", {
        v: 1,
        type: "send",
        chatId: "123",
        text: "x".repeat(8 * 1024 * 1024),
      })
    ).toBe(false)
  })
  it("按 chatId 只发给持有该会话的 client", async () => {
    server = await startServer({ a: "token-aaaa1111", b: "token-bbbb2222" })
    const wsA = await connect("token-aaaa1111")
    const wsB = await connect("token-bbbb2222")
    const recvA: string[] = []
    const recvB: string[] = []
    wsA.on("message", (d) => recvA.push(String(d)))
    wsB.on("message", (d) => recvB.push(String(d)))

    wsA.send(helloFrame("a", [{ id: "111", name: "A 群" }]))
    wsB.send(helloFrame("b", [{ id: "222", name: "B 群" }]))
    await vi.waitUntil(() => server!.stats().chats === 2, { timeout: 2000 })

    server.send("111", {
      v: PROTOCOL_VERSION,
      type: "send",
      chatId: "111",
      text: "给 A",
    })
    await vi.waitUntil(() => recvA.some((m) => m.includes("给 A")), {
      timeout: 2000,
    })
    expect(recvB.some((m) => m.includes("给 A"))).toBe(false)

    wsA.close()
    wsB.close()
  })

  it("无可用连接 → send 返回 false 而非抛错", async () => {
    server = await startServer({ "mirai-1": "tok-12345678" })
    const ok = server.send("999", {
      v: PROTOCOL_VERSION,
      type: "send",
      chatId: "999",
      text: "x",
    })
    expect(ok).toBe(false)
  })
})

describe("MiraiWsServer 生命周期", () => {
  it("断开后清理该 client 的路由", async () => {
    server = await startServer({ "mirai-1": "tok-12345678" })
    const ws = await connect("tok-12345678")
    ws.send(helloFrame("mirai-1", [{ id: "123", name: "群甲" }]))
    await vi.waitUntil(() => server!.stats().chats === 1, { timeout: 2000 })

    ws.close()
    await vi.waitUntil(() => server!.stats().conns === 0, { timeout: 2000 })
    expect(server.stats().chats).toBe(0)
    expect(server.isConnected()).toBe(false)
  })

  it("stop 后端口释放,可再次监听同端口", async () => {
    const s1 = new MiraiWsServer({ port: 0, clients: { a: "tok-12345678" } })
    await s1.start()
    const p = (
      s1 as unknown as { wss?: { address(): { port: number } } }
    ).wss!.address().port
    await s1.stop()

    const s2 = new MiraiWsServer({ port: p, clients: { a: "tok-12345678" } })
    await expect(s2.start()).resolves.toBeUndefined()
    await s2.stop()
  })

  it("端口被占用 → start reject(供 registry 记 lastError)", async () => {
    server = await startServer({ a: "tok-12345678" })
    const dup = new MiraiWsServer({ port, clients: { a: "tok-12345678" } })
    await expect(dup.start()).rejects.toThrow()
    await dup.stop()
  })

  it("onStatus 在首连与全断时回调", async () => {
    const states: boolean[] = []
    server = await startServer({ a: "tok-12345678" })
    // 重建以注入 onStatus
    await server.stop()
    server = new MiraiWsServer({
      port: 0,
      clients: { a: "tok-12345678" },
      onStatus: (c) => states.push(c),
    })
    await server.start()
    port = (
      server as unknown as { wss?: { address(): { port: number } } }
    ).wss!.address().port

    const ws = await connect("tok-12345678")
    ws.send(helloFrame("a", []))
    await vi.waitUntil(() => states.includes(true), { timeout: 2000 })
    ws.close()
    await vi.waitUntil(() => states.includes(false), { timeout: 2000 })
  })
})
