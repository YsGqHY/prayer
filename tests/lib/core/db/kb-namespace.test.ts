import { describe, it, expect, beforeEach } from "vitest"
import { openDb } from "@/lib/core/db/index"
import { Repo } from "@/lib/core/db/repo"
import { CURRENT_SCHEMA_VERSION } from "@/lib/core/db/migrations/index"
import {
  DEFAULT_KB_NAMESPACE,
  resolveKbNamespace,
  chatsMissingKbNamespace,
} from "@/lib/core/chat/enabled-chats"

let repo: Repo
// 三维向量:同向 → 距离 0,便于用同一 query 命中不同分区里的条目
const vec = () => new Float32Array([1, 0, 0])

beforeEach(() => {
  repo = new Repo(openDb(":memory:", 3))
})

describe("kb namespace 分区隔离", () => {
  it("各分区只检索到自己的知识,不串到其它租户", () => {
    repo.insertKbEntry("faq.md", "甲租户的退款政策", "faq.md", vec(), "acme")
    repo.insertKbEntry("faq.md", "乙租户的退款政策", "faq.md", vec(), "globex")

    const acme = repo.searchKb(vec(), 5, "acme")
    expect(acme).toHaveLength(1)
    expect(acme[0].content).toBe("甲租户的退款政策")

    const globex = repo.searchKb(vec(), 5, "globex")
    expect(globex).toHaveLength(1)
    expect(globex[0].content).toBe("乙租户的退款政策")
  })

  it("漏配的会话命中 default,而不是任何其它租户分区", () => {
    repo.insertKbEntry("faq.md", "存量语料", "faq.md", vec(), "default")
    repo.insertKbEntry("faq.md", "甲租户机密", "faq.md", vec(), "acme")

    // 未配 kbNamespace → resolveKbNamespace 回落 default
    const ns = resolveKbNamespace({ groupPolicies: {} }, "qq", "100")
    expect(ns).toBe(DEFAULT_KB_NAMESPACE)

    const hits = repo.searchKb(vec(), 5, ns)
    expect(hits).toHaveLength(1)
    expect(hits[0].content).toBe("存量语料")
  })

  it("searchBaseKb 同样按分区隔离", () => {
    repo.insertKbEntry("doc.md", "甲文档", "doc.md", vec(), "acme")
    repo.insertKbEntry("doc.md", "乙文档", "doc.md", vec(), "globex")

    const hits = repo.searchBaseKb(vec(), 5, "acme")
    expect(hits).toHaveLength(1)
    expect(hits[0].content).toBe("甲文档")
  })

  it("同名 doc 跨分区独立:删一个分区不影响另一个", () => {
    repo.insertKbEntry("faq.md", "甲的 FAQ", "faq.md", vec(), "acme")
    repo.insertKbEntry("faq.md", "乙的 FAQ", "faq.md", vec(), "globex")

    expect(repo.deleteKbDoc("faq.md", "acme")).toBe(1)
    expect(repo.searchKb(vec(), 5, "acme")).toHaveLength(0)
    expect(repo.searchKb(vec(), 5, "globex")).toHaveLength(1)
    // 向量表同步清理,不留孤儿
    const t = repo.kbTotals()
    expect(t.chunks).toBe(t.vecs)
  })

  it("kbDocStats 按 (namespace, doc) 分组,可按分区筛选", () => {
    repo.insertKbEntry("faq.md", "甲", "faq.md", vec(), "acme")
    repo.insertKbEntry("faq.md", "乙", "faq.md", vec(), "globex")

    const all = repo.kbDocStats()
    expect(all).toHaveLength(2)
    expect(all.map((r) => r.namespace).sort()).toEqual(["acme", "globex"])

    const only = repo.kbDocStats("acme")
    expect(only).toEqual([{ namespace: "acme", doc: "faq.md", chunks: 1 }])
  })

  it("v9 迁移:存量 chunk 回填 default", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(9)
    // 模拟旧库写法(不带 namespace 列)后读回
    const db = openDb(":memory:", 3)
    db.prepare(
      "INSERT INTO kb_chunks (doc, content, source) VALUES ('old.md', '存量', 'old.md')"
    ).run()
    const row = db
      .prepare("SELECT namespace FROM kb_chunks WHERE doc = 'old.md'")
      .get() as { namespace: string } | undefined
    expect(row?.namespace).toBe("default")
    db.close()
  })
})

describe("chatsMissingKbNamespace", () => {
  it("列出已生效但未配分区的会话,配了的不列", () => {
    const missing = chatsMissingKbNamespace({
      enabledChats: [
        { channel: "qq", chatId: "100" },
        { channel: "qq", chatId: "200" },
        { channel: "tg", chatId: "-300" },
      ],
      groupPolicies: {
        "qq:200": { kbNamespace: "acme" },
        // 空白视为未配,防止空串静默落 default
        "tg:-300": { kbNamespace: "   " },
      },
    })
    expect(missing).toEqual([
      { channel: "qq", chatId: "100" },
      { channel: "tg", chatId: "-300" },
    ])
  })

  it("全部配齐 → 空数组", () => {
    const missing = chatsMissingKbNamespace({
      enabledChats: [{ channel: "qq", chatId: "100" }],
      groupPolicies: { "qq:100": { kbNamespace: "acme" } },
    })
    expect(missing).toEqual([])
  })
})
