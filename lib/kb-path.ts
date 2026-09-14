import { resolve, sep } from "node:path"

export const KB_DIR = "docs/kb"
export const KB_ROOT = resolve(KB_DIR)

/** 相对路径是否合法(无穿越、仅 .md/.txt、posix 分隔) */
export function isKbRelPath(rel: string): boolean {
  if (!rel || typeof rel !== "string") return false
  if (rel.includes("\0") || rel.includes("\\")) return false
  if (rel.startsWith("/") || rel.startsWith("./") || rel.startsWith("../"))
    return false
  const parts = rel.split("/")
  if (parts.some((p) => !p || p === "." || p === "..")) return false
  return rel.endsWith(".md") || rel.endsWith(".txt")
}

/**
 * 知识库相对路径 → 分区名。一级子目录名即分区,根目录散文件归 default。
 * 例:acme/faq/退款.md → acme;README.md → default。
 * 路径→分区的唯一事实源(ingest 与 kb API 共用);回落值与 resolveKbNamespace 一致。
 */
export function namespaceOfRel(rel: string): string {
  const i = rel.indexOf("/")
  if (i <= 0) return "default"
  return rel.slice(0, i)
}

/** catch-all 段 → 相对 posix 路径 */
export function relFromParts(parts: string[]): string {
  return parts.map((p) => decodeURIComponent(p)).join("/")
}

/** 相对路径 → 绝对路径;非法返回 null */
export function safeKbAbs(rel: string): string | null {
  if (!isKbRelPath(rel)) return null
  const p = resolve(KB_DIR, rel)
  if (p !== KB_ROOT && !p.startsWith(KB_ROOT + sep)) return null
  return p
}
