import { once } from "node:events"
import type { AddressInfo } from "node:net"
import WebSocket, { WebSocketServer } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  MiraiWsClient,
  type MiraiClientOpts,
} from "@/lib/channels/mirai/client"
import { MiraiChannel } from "@/lib/channels/mirai"
import { bus } from "@/lib/bus"
import type { IncomingMessage } from "@/lib/events"

const token = "loopback-token"
const hello = {
  v: 1,
  type: "hello",
  clientId: "mirai-1",
  botId: 10001,
  chats: [{ id: "123", name: "Test group" }],
}
const clients: MiraiWsClient[] = []
const servers: WebSocketServer[] = []
const listeners: ((m: IncomingMessage) => void)[] = []

async function plugin(
  options: { hello?: boolean; identity?: string; reject?: boolean } = {}
) {
  const headers: string[] = []
  const sockets: WebSocket[] = []
  const frames: Record<string, unknown>[] = []
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    verifyClient: (info, done) => {
      headers.push(info.req.headers.authorization ?? "")
      done(
        !options.reject && info.req.headers.authorization === `Bearer ${token}`,
        401
      )
    },
  })
  servers.push(wss)
  wss.on("connection", (ws) => {
    sockets.push(ws)
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data))
      frames.push(frame)
      if (frame.type === "ping") ws.send(JSON.stringify({ v: 1, type: "pong" }))
    })
    if (options.hello !== false)
      ws.send(
        JSON.stringify({
          ...hello,
          clientId: options.identity ?? hello.clientId,
        })
      )
  })
  await once(wss, "listening")
  return {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    headers,
    sockets,
    frames,
  }
}

async function start(url: string, options: Partial<MiraiClientOpts> = {}) {
  const client = new MiraiWsClient({
    url,
    token,
    clientId: "mirai-1",
    backoffMs: 25,
    maxBackoffMs: 100,
    ...options,
  })
  clients.push(client)
  await client.start()
  return client
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop()
  for (const wss of servers.splice(0)) {
    for (const ws of wss.clients) ws.terminate()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  }
  for (const listener of listeners.splice(0))
    bus.off("message.received", listener)
})

describe("MiraiWsClient", () => {
  it("Bearer 后等待插件 hello，不发送自己的 hello", async () => {
    const remote = await plugin({ hello: false })
    const client = await start(remote.url)
    await vi.waitUntil(() => remote.sockets.length === 1)
    expect(client.isConnected()).toBe(false)
    expect(await client.request("listChats")).toBeUndefined()
    remote.sockets[0].send(JSON.stringify(hello))
    await vi.waitUntil(() => client.isConnected())
    expect(remote.headers).toEqual([`Bearer ${token}`])
    expect(remote.frames).toEqual([])
    expect(client.knownChats()).toEqual(hello.chats)
  })

  it("身份一致后双向消息及查询可用", async () => {
    const remote = await plugin()
    const client = await start(remote.url)
    await vi.waitUntil(() => client.isConnected())
    const got: IncomingMessage[] = []
    const handler = (message: IncomingMessage) => got.push(message)
    listeners.push(handler)
    bus.on("message.received", handler)
    remote.sockets[0].send(
      JSON.stringify({
        v: 1,
        type: "message",
        chatId: "123",
        userId: "456",
        messageId: "m-1",
        text: "hello",
        botMentioned: true,
      })
    )
    await vi.waitUntil(() => got.length > 0)
    expect(got[0]).toMatchObject({
      channel: "mirai",
      rawText: "hello",
      botMentioned: true,
    })
    expect(
      client.send("123", {
        v: 1,
        type: "send",
        chatId: "123",
        text: "reply",
        replyToId: "m-1",
      })
    ).toBe(true)
    await vi.waitUntil(() =>
      remote.frames.some((frame) => frame.type === "send")
    )
    remote.sockets[0].on("message", (raw) => {
      const frame = JSON.parse(String(raw))
      if (frame.type === "request")
        remote.sockets[0].send(
          JSON.stringify({
            v: 1,
            type: "response",
            echo: frame.echo,
            data: [{ id: "member" }],
          })
        )
    })
    expect(
      await client.request("listMembers", { chatId: "123" }, "123")
    ).toEqual([{ id: "member" }])
  })

  it("身份不符时拒绝路由", async () => {
    const remote = await plugin({ identity: "another-plugin" })
    const client = await start(remote.url, { backoffMs: 1000 })
    await vi.waitUntil(() => !!client.getLastError())
    expect(client.isConnected()).toBe(false)
    expect(client.knownChats()).toEqual([])
    expect(client.getLastError()).toContain("clientId")
  })

  it("鉴权失败重试且错误不泄露 token", async () => {
    const remote = await plugin({ reject: true })
    const client = await start(remote.url)
    await vi.waitUntil(() => remote.headers.length >= 2)
    expect(client.isConnected()).toBe(false)
    expect(client.getLastError()).not.toContain(token)
  })

  it("hello 超时会关闭并重连", async () => {
    const remote = await plugin({ hello: false })
    const client = await start(remote.url, { helloTimeoutMs: 35 })
    await vi.waitUntil(() => remote.sockets.length >= 2)
    expect(client.isConnected()).toBe(false)
    expect(client.getLastError()).toContain("hello")
  })

  it("断线回收请求与路由，再重连恢复", async () => {
    const remote = await plugin()
    const client = await start(remote.url, { backoffMs: 100 })
    await vi.waitUntil(() => client.isConnected())
    const result = client.request("listMembers", { chatId: "123" }, "123")
    remote.sockets[0].terminate()
    expect(await result).toBeUndefined()
    expect(client.knownChats()).toEqual([])
    await vi.waitUntil(() => remote.sockets.length >= 2 && client.isConnected())
    expect(client.getLastError()).toBeUndefined()
  })

  it("心跳保活，无回应时失活重连", async () => {
    const remote = await plugin()
    const client = await start(remote.url, {
      pingIntervalMs: 15,
      livenessMs: 80,
    })
    await vi.waitUntil(
      () => remote.frames.filter((frame) => frame.type === "ping").length >= 3
    )
    expect(client.isConnected()).toBe(true)
    remote.sockets[0].removeAllListeners("message")
    await vi.waitUntil(() => remote.sockets.length >= 2)
  })

  it("stop 回收请求且不再重连，可重新 start", async () => {
    const remote = await plugin()
    const client = await start(remote.url)
    await vi.waitUntil(() => client.isConnected())
    const pending = client.request("listChats")
    await client.stop()
    expect(await pending).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(remote.sockets).toHaveLength(1)
    expect(client.isConnected()).toBe(false)
    await client.start()
    await vi.waitUntil(() => client.isConnected())
    expect(remote.sockets).toHaveLength(2)
  })

  it("CONNECTING 期间 stop 不报未处理错误或重连", async () => {
    const remote = await plugin()
    const client = await start(remote.url)
    await client.stop()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(client.isConnected()).toBe(false)
    expect(remote.sockets.length).toBeLessThanOrEqual(1)
  })

  it("查询超时回收，通道状态带模式，非法 URL 不泄密", async () => {
    const remote = await plugin()
    const client = await start(remote.url, { requestTimeoutMs: 25 })
    await vi.waitUntil(() => client.isConnected())
    expect(await client.request("listChats")).toBeUndefined()
    const channel = new MiraiChannel({
      mode: "client",
      url: remote.url,
      token,
      clientId: "mirai-1",
    })
    expect(channel.status().detail).toContain("mode=client")
    await expect(start("not-a-url-secret")).rejects.toThrow("地址无效")
  })
})
