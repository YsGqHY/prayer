import { describe, expect, it, vi } from "vitest"

// 配置桩:两个生效会话(一个配了分区、一个没配)+ 一个管理面
const cfg = {
  enabledChats: [
    { channel: "qq", chatId: "100" },
    { channel: "qq", chatId: "200" },
  ],
  adminSurface: { channel: "qq", chatId: "999" },
  groupPolicies: {
    "qq:100": { kbNamespace: "acme" },
    // 空白视为未配,不能当成已显式指定
    "qq:200": { kbNamespace: "  " },
  },
  proactiveEnabled: false,
  proactiveSilenceMs: 180_000,
}

vi.mock("@/lib/app-context", () => ({
  getAppContext: () => ({ cfg, repo: {} }),
}))
vi.mock("@/lib/reflect-stats", () => ({
  buildGroupChatStats: () => ({
    cursors: new Map(),
    msg: new Map(),
    sed: new Map(),
  }),
}))
import { GET } from "@/app/api/groups/activity/route"

type Row = {
  chatId: string
  isAdmin?: boolean
  missingKbNamespace?: boolean
  effective: { kbNamespace: string }
}

async function rows(): Promise<Row[]> {
  const res = await GET()
  const body = await res.json()
  expect(res.status).toBe(200)
  return body.data.groups as Row[]
}

describe("groups activity route 知识库分区", () => {
  it("配了分区的会话解析为该分区,且不告警", async () => {
    const r = (await rows()).find((x) => x.chatId === "100")!
    expect(r.effective.kbNamespace).toBe("acme")
    expect(r.missingKbNamespace).toBe(false)
  })

  it("未配(含空白)的生效会话回落 default 并告警", async () => {
    const r = (await rows()).find((x) => x.chatId === "200")!
    expect(r.effective.kbNamespace).toBe("default")
    expect(r.missingKbNamespace).toBe(true)
  })

  it("管理面不参与分区告警(不进客服流程、不检索知识库)", async () => {
    const r = (await rows()).find((x) => x.chatId === "999")!
    expect(r.isAdmin).toBe(true)
    expect(r.missingKbNamespace).toBe(false)
  })

  it("globals 暴露回落分区,供前端显示「跟随默认」", async () => {
    const res = await GET()
    const body = await res.json()
    expect(body.data.globals.kbNamespace).toBe("default")
  })
})
