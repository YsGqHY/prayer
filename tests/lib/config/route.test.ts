import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { openDb } from "@/lib/db"
import { Repo } from "@/lib/db/repo"
import { getConfig, setConfig } from "@/lib/config-store"

let db: ReturnType<typeof openDb>
const { reconfigure, defaultBuilders } = vi.hoisted(() => ({
  reconfigure: vi.fn(),
  defaultBuilders: vi.fn(async () => ({})),
}))
vi.mock("@/lib/db/shared", () => ({
  sharedDb: () => db,
  sharedRepo: () => new Repo(db),
}))
vi.mock("@/lib/runtime", () => ({
  getRuntime: () => ({ reconfigure }),
  defaultBuilders,
}))

import { GET, PUT } from "@/app/api/config/route"

beforeEach(() => {
  vi.clearAllMocks()
  db = openDb(":memory:", 3)
  getConfig(new Repo(db), {})
})
afterEach(() => db.close())

function put(body: unknown) {
  return PUT(
    new NextRequest("http://localhost/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  )
}

describe("配置 HTTP 边界", () => {
  it("客户端模式保存、掩码回传、切回服务端均保留另一侧凭据", async () => {
    const repo = new Repo(db)
    const response = await put({
      miraiWsEnabled: true,
      miraiWsMode: "client",
      miraiWsUrl: "ws://127.0.0.1:3003",
      miraiWsClientId: "mirai-1",
      miraiWsToken: "client-secret",
      miraiWsClients: { "mirai-1": "server-secret" },
    })
    expect(response.status).toBe(200)
    const { data } = await response.json()
    expect(data.miraiWsToken).toBe("••••cret")
    expect(data.miraiWsClients["mirai-1"]).toBe("••••cret")
    expect((await put({ ...data, miraiWsMode: "server" })).status).toBe(200)
    expect(getConfig(repo)).toMatchObject({
      miraiWsMode: "server",
      miraiWsToken: "client-secret",
      miraiWsClients: { "mirai-1": "server-secret" },
    })
    expect((await put({ miraiWsMode: "client" })).status).toBe(200)
    expect(reconfigure.mock.lastCall?.[0].miraiWsToken).toBe("client-secret")
  })

  it.each([
    { miraiWsUrl: "https://example.com" },
    { miraiWsUrl: "ws://user:password@localhost" },
    { miraiWsUrl: "ws://localhost/#fragment" },
    { miraiWsUrl: "" },
    { miraiWsClientId: "bad id" },
    { miraiWsToken: "tiny" },
    { miraiWsToken: "line\nbreak" },
    { miraiWsToken: "••••fake" },
  ])("客户端非法配置 %j 不写库不重启", async (patch) => {
    const repo = new Repo(db)
    const before = repo.getConfigRow("app")
    const response = await put({
      miraiWsEnabled: true,
      miraiWsMode: "client",
      miraiWsUrl: "ws://127.0.0.1:3003",
      miraiWsClientId: "mirai-1",
      miraiWsToken: "valid-token",
      ...patch,
    })
    expect(response.status).toBe(400)
    expect(repo.getConfigRow("app")).toBe(before)
    expect(reconfigure).not.toHaveBeenCalled()
  })

  it("服务端拒绝无凭据与重复 token，关闭通道可保存未完成的客户端草稿", async () => {
    expect((await put({ miraiWsEnabled: true })).status).toBe(400)
    expect(
      (
        await put({
          miraiWsEnabled: true,
          miraiWsClients: { a: "same-token", b: "same-token" },
        })
      ).status
    ).toBe(400)
    expect(
      (
        await put({
          miraiWsEnabled: false,
          miraiWsMode: "client",
          miraiWsUrl: "",
        })
      ).status
    ).toBe(200)
  })
  it("GET 只返回掩码，数据库保留原密钥", async () => {
    const repo = new Repo(db)
    setConfig(repo, {
      onebotAccessToken: "test-secret",
      telegramBotToken: "tg-secret",
    })
    const response = await GET()
    const { data } = await response.json()
    expect(data.onebotAccessToken).toBe("••••cret")
    expect(data.telegramBotToken).toBe("••••cret")
    expect(getConfig(repo).onebotAccessToken).toBe("test-secret")
  })

  it("局部保存只更改提交字段，向运行时传递实际配置", async () => {
    const repo = new Repo(db)
    setConfig(repo, {
      onebotAccessToken: "secret",
      supportUrl: "https://example.com",
    })
    const response = await put({ maxReplyChars: 0, topicScanMs: 5000 })
    expect(response.status).toBe(200)
    expect(getConfig(repo)).toMatchObject({
      maxReplyChars: 0,
      topicScanMs: 5000,
      onebotAccessToken: "secret",
      supportUrl: "https://example.com",
    })
    expect(reconfigure).toHaveBeenCalledExactlyOnceWith(getConfig(repo), {})
    expect((await response.json()).data.onebotAccessToken).toBe("••••cret")
  })

  it("全量回传掩码不覆盖密钥，管理面不能留在生效列表", async () => {
    const repo = new Repo(db)
    setConfig(repo, { telegramBotToken: "test-token" })
    const { data } = await (await GET()).json()
    const response = await put({
      ...data,
      adminSurface: { channel: "tg", chatId: " -100 " },
      enabledChats: [
        { channel: "tg", chatId: "-100" },
        { channel: "qq", chatId: "100" },
      ],
    })
    expect(response.status).toBe(200)
    expect(getConfig(repo).telegramBotToken).toBe("test-token")
    expect(getConfig(repo).enabledChats).toEqual([
      { channel: "qq", chatId: "100" },
    ])
  })

  it.each([
    null,
    [],
    { ackEnabled: "false" },
    { groupPolicies: { "qq:1": { proactiveSilenceMs: -1 } } },
  ])("非法请求 %j 不写库也不重启", async (input) => {
    const repo = new Repo(db)
    const before = repo.getConfigRow("app")
    const response = await put(input)
    expect(response.status).toBe(400)
    expect(repo.getConfigRow("app")).toBe(before)
    expect(reconfigure).not.toHaveBeenCalled()
    expect(defaultBuilders).not.toHaveBeenCalled()
  })

  it("无效 JSON 返回 400 而非抛出异常", async () => {
    const response = await PUT(
      new NextRequest("http://localhost/api/config", {
        method: "PUT",
        body: "{",
      })
    )
    expect(response.status).toBe(400)
    expect(reconfigure).not.toHaveBeenCalled()
  })
})
