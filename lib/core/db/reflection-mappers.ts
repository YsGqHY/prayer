import type { ReflectionRow } from "./rows.ts"
import type { ReflectionStatus, ReflectionEntry } from "./models.ts"

/**
 * 解析反思 source。三种形态:
 * - 沉淀:human-reflection:{channel}:{chatId}:{ts}
 * - 整理后:human-reflection:ns={namespace}:{ts} —— 不再对应单一来源 chat,
 *   故 channel/chatId 为 null,但 ts 是真实整理时间,必须保留(web 侧要显示)
 * - 旧库:human-reflection:{gid}:{ts} → 归 qq
 */
export function parseReflectionSource(
  source: string | null
): { channel: string | null; chatId: string | null; ts: number } | null {
  if (!source?.startsWith("human-reflection:")) return null
  const rest = source.slice("human-reflection:".length)
  const parts = rest.split(":")
  // 整理后条目:仅带分区标记与时间戳
  if (parts.length === 2 && parts[0].startsWith("ns=")) {
    const ts = Number(parts[1])
    if (!Number.isFinite(ts)) return null
    return { channel: null, chatId: null, ts }
  }
  // 新格式:至少 channel + chatId + ts
  if (parts.length >= 3) {
    const channel = parts[0]
    // 已知 channel 前缀,或非纯数字首段(避免把旧 gid 误当 channel)
    if (channel === "qq" || channel === "tg" || channel === "discord") {
      const ts = Number(parts[parts.length - 1])
      if (!Number.isFinite(ts)) return null
      const chatId = parts.slice(1, -1).join(":")
      if (!chatId) return null
      return { channel, chatId, ts }
    }
  }
  // 旧格式:human-reflection:{qqGroupId}:{ts}
  if (parts.length === 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
    return { channel: "qq", chatId: parts[0], ts: Number(parts[1]) }
  }
  return null
}

/** 解析存库的 JSON 字符串数组;非法或非数组一律回退 [] */
export function parseStringArray(s: string): string[] {
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

// kb_chunks(reflection JOIN meta)行 → 反思条目视图;reflectionEntries/
// reflectionEntrySummaries/reflectionEntryDetail 三处共用,保证形状一致
export function mapReflectionRow(r: ReflectionRow): ReflectionEntry {
  const parsed = parseReflectionSource(r.source)
  return {
    id: r.id,
    content: r.content,
    channel: parsed?.channel ?? null,
    chatId: parsed?.chatId ?? null,
    ts: parsed?.ts ?? null,
    question: r.question,
    answer: r.answer,
    status: normalizeReflectionStatus(r.status),
    // 旧行(查询未选该列)回落 default,与 resolveKbNamespace 的漏配语义一致
    namespace: r.namespace ?? "default",
  }
}

/** 无元数据或未知旧状态沿用 approved，避免历史知识在升级后消失。 */
export function normalizeReflectionStatus(
  status: string | null | undefined
): ReflectionStatus {
  return status === "rejected" || status === "pending" || status === "promoted"
    ? status
    : "approved"
}
