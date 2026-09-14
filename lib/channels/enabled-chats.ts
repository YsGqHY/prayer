import type { ChannelId, ChatRef } from "./types"
import type { AppConfig, GroupPolicy } from "../config-store"

export type { ChatRef }

/** policy / 游标 key：`${channel}:${chatId}` */
export function policyKey(channel: ChannelId, chatId: string): string {
  return `${channel}:${chatId}`
}

/** 生效会话配置源（仅 chat-ref 列表） */
export interface EnablementConfig {
  enabledChats?: ChatRef[]
}

/**
 * 汇总已生效会话。
 * 缺省 / 非数组 → []。
 */
export function listEnabledChats(cfg: EnablementConfig): ChatRef[] {
  return Array.isArray(cfg.enabledChats) ? cfg.enabledChats : []
}

/** 某通道会话是否在白名单 */
export function isChatEnabled(
  cfg: EnablementConfig,
  channel: ChannelId,
  chatId: string
): boolean {
  const list = listEnabledChats(cfg)
  return list.some((c) => c.channel === channel && c.chatId === chatId)
}

/**
 * 解析管理侧通知面（admin surface）。
 * - 显式 `adminSurface`（含 null）直接用
 * - 否则 null
 */
export function resolveAdminSurface(cfg: {
  adminSurface?: ChatRef | null
}): ChatRef | null {
  if (cfg.adminSurface === undefined) return null
  return cfg.adminSurface
}

/** 是否为配置的管理面会话（管理命令 / 跳过缓冲） */
export function isAdminSurface(
  surface: ChatRef | null | undefined,
  channel: ChannelId,
  chatId: string
): boolean {
  return !!surface && surface.channel === channel && surface.chatId === chatId
}

/**
 * 读群/会话策略：优先 `channel:chatId`，
 * QQ 兼容旧库裸 chatId（群号字符串）键。
 */
export function getGroupPolicy(
  cfg:
    | Pick<AppConfig, "groupPolicies">
    | { groupPolicies: Record<string, GroupPolicy> },
  channel: ChannelId,
  chatId: string
): GroupPolicy | undefined {
  const policies = cfg.groupPolicies
  const keyed = policies[policyKey(channel, chatId)]
  if (keyed !== undefined) return keyed
  // legacy：仅 QQ 裸群号键
  if (channel === "qq") return policies[chatId]
  return undefined
}

/** 未配置 kbNamespace 时的回落分区(亦为存量语料所在分区) */
export const DEFAULT_KB_NAMESPACE = "default"

/**
 * 解析会话对应的知识库分区。全项目唯一入口,禁止各调用点自行拼装。
 *
 * 一个会话只有一份知识库;多个会话可共用同一 namespace(同租户多群)。
 * 未配置 → DEFAULT_KB_NAMESPACE:存量兼容所必需,但多租户下漏配等于读到
 * default 分区(跨租户泄漏面),后台对「已生效但未配」的会话给出显式告警。
 * 复用 getGroupPolicy,连带获得 QQ 裸群号 legacy 键兼容。
 */
export function resolveKbNamespace(
  cfg:
    | Pick<AppConfig, "groupPolicies">
    | { groupPolicies: Record<string, GroupPolicy> },
  channel: ChannelId,
  chatId: string
): string {
  const ns = getGroupPolicy(cfg, channel, chatId)?.kbNamespace?.trim()
  return ns || DEFAULT_KB_NAMESPACE
}

/** 会话级 namespace 解析器:注入给编排与旁路轮询器,避免各处传整张 policies 表 */
export type KbNamespaceResolver = (
  channel: ChannelId,
  chatId: string
) => string

/**
 * 已生效但未显式配置 kbNamespace 的会话。
 *
 * 这类会话会静默回落 default 分区,多租户下等于读到存量语料或别的未配置会话
 * 沉淀的知识 —— 是本功能唯一的跨租户泄漏面。后台据此给出显式告警,
 * 而不是让默认值悄悄生效。单租户部署全部落 default 属正常,可忽略该提示。
 */
export function chatsMissingKbNamespace(
  cfg: Pick<AppConfig, "groupPolicies"> & EnablementConfig
): ChatRef[] {
  return listEnabledChats(cfg).filter(
    (c) => !getGroupPolicy(cfg, c.channel, c.chatId)?.kbNamespace?.trim()
  )
}

/** 从完整 AppConfig 一次解析 agent 装配用的生效会话 + 管理面 */
export function resolveRuntimeChatConfig(cfg: AppConfig): {
  enabledChats: ChatRef[]
  adminSurface: ChatRef | null
} {
  return {
    enabledChats: listEnabledChats(cfg),
    adminSurface: resolveAdminSurface(cfg),
  }
}
