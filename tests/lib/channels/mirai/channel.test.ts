import { describe, it, expect } from "vitest"
import { formatMiraiDetail } from "@/lib/channels/mirai"
import { parseSessionKey, makeSessionKey } from "@/lib/core/chat/ids"
import { CHANNEL_IDS } from "@/lib/core/chat/types"
import {
  createChannels,
  DEFAULT_CHANNEL_FACTORIES,
} from "@/lib/channels/factory"
import type { AppConfig } from "@/lib/core/config-store"
import type { Repo } from "@/lib/core/db/repo"

/** 只给工厂用到的字段;其余字段工厂不读,避免整份 AppConfig 字面量 */
function baseCfg(): AppConfig {
  return {
    miraiWsEnabled: false,
    miraiWsPort: 3002,
    miraiWsClients: {},
    onebotWsUrl: "",
    telegramBotToken: "",
  } as unknown as AppConfig
}

const ctx = (cfg: AppConfig) => ({ cfg, repo: {} as Repo })

describe("mirai 通道标识", () => {
  it("mirai 在 CHANNEL_IDS 中", () => {
    expect(CHANNEL_IDS).toContain("mirai")
  })

  it("sessionKey 可解析(与 qq 形态一致)", () => {
    const key = makeSessionKey("mirai", "123", "456")
    expect(key).toBe("mirai:123:456")
    expect(parseSessionKey(key)).toEqual({
      channel: "mirai",
      chatId: "123",
      userId: "456",
    })
  })

  it("mirai 与 qq 是不同的键(既有数据不会串)", () => {
    expect(makeSessionKey("mirai", "123", "456")).not.toBe(
      makeSessionKey("qq", "123", "456")
    )
  })
})

describe("mirai 工厂注册", () => {
  it("客户端模式不要求服务端凭据表，缺少连接参数则不注册", () => {
    const cfg: AppConfig = {
      ...baseCfg(),
      miraiWsEnabled: true,
      miraiWsMode: "client",
      miraiWsUrl: "ws://127.0.0.1:3003",
      miraiWsClientId: "mirai-1",
      miraiWsToken: "client-token",
    }
    expect(
      createChannels(ctx(cfg))
        .find((c) => c.id === "mirai")
        ?.status().detail
    ).toContain("mode=client")
    expect(
      createChannels(ctx({ ...cfg, miraiWsUrl: "" })).find(
        (c) => c.id === "mirai"
      )
    ).toBeUndefined()
    expect(
      createChannels(ctx({ ...cfg, miraiWsToken: "" })).find(
        (c) => c.id === "mirai"
      )
    ).toBeUndefined()
  })
  it("miraiWsEnabled=false → 不注册", () => {
    const chans = createChannels(
      ctx(baseCfg()) as never,
      DEFAULT_CHANNEL_FACTORIES
    )
    expect(chans.find((c) => c.id === "mirai")).toBeUndefined()
  })

  it("启用但无凭据 → 不注册(不开放无鉴权端口)", () => {
    const cfg = { ...baseCfg(), miraiWsEnabled: true, miraiWsClients: {} }
    const chans = createChannels(
      ctx(cfg as AppConfig) as never,
      DEFAULT_CHANNEL_FACTORIES
    )
    expect(chans.find((c) => c.id === "mirai")).toBeUndefined()
  })

  it("凭据全为空白 → 不注册", () => {
    const cfg = {
      ...baseCfg(),
      miraiWsEnabled: true,
      miraiWsClients: { "  ": "  " },
    }
    const chans = createChannels(
      ctx(cfg as AppConfig) as never,
      DEFAULT_CHANNEL_FACTORIES
    )
    expect(chans.find((c) => c.id === "mirai")).toBeUndefined()
  })

  it("启用且有凭据 → 注册,capabilities 支持旁路", () => {
    const cfg = {
      ...baseCfg(),
      miraiWsEnabled: true,
      miraiWsClients: { "mirai-1": "tok-12345678" },
    }
    const chans = createChannels(
      ctx(cfg as AppConfig) as never,
      DEFAULT_CHANNEL_FACTORIES
    )
    const mirai = chans.find((c) => c.id === "mirai")
    expect(mirai).toBeDefined()
    // mirai 能给出可靠 senderRole,反思/归类/主动补位均可用
    expect(mirai!.capabilities.supportsBypassPipeline).toBe(true)
    expect(mirai!.capabilities.supportsAdminCommands).toBe(true)
  })
})

describe("formatMiraiDetail", () => {
  const now = 1_000_000

  it("无连接无统计 → undefined(调用方回落)", () => {
    expect(
      formatMiraiDetail({ clients: 0, conns: 0, chats: 0, rejected: 0 }, now)
    ).toBeUndefined()
  })

  it("拼出连接数、会话数与最近接收", () => {
    const s = formatMiraiDetail(
      {
        clients: 2,
        conns: 3,
        chats: 5,
        lastRxAt: now - 12_000,
        rejected: 0,
      },
      now
    )
    expect(s).toContain("conns=3/2")
    expect(s).toContain("chats=5")
    expect(s).toContain("rx=12s ago")
  })

  it("被拒次数非零时暴露,便于发现 token 配错", () => {
    const s = formatMiraiDetail(
      { clients: 1, conns: 1, chats: 0, rejected: 7 },
      now
    )
    expect(s).toContain("rejected=7")
  })
})
