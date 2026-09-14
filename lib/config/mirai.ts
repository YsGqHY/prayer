import type { AppConfig } from "./schema"

const CLIENT_ID = /^[A-Za-z0-9._-]{1,64}$/

function validToken(token: string, allowMask: boolean): boolean {
  if (token.includes("•")) return allowMask
  // Bearer 凭据要能放入 HTTP header；禁止控制字符和空白。
  return token.length >= 8 && /^[\x21-\x7e]+$/.test(token)
}

/** 按启用的模式校验完整配置；API 必须在密钥合并后、写库前调用。 */
export function miraiConfigError(
  cfg: AppConfig,
  allowMask = false
): string | null {
  if (!cfg.miraiWsEnabled) return null
  if ((cfg.miraiWsMode ?? "server") === "client") {
    try {
      const url = new URL(cfg.miraiWsUrl ?? "")
      if (
        !["ws:", "wss:"].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.hash
      ) {
        return "Mirai 服务端地址须为 ws:// 或 wss://，且不能包含用户名、密码或 # 片段"
      }
    } catch {
      return "请填写有效的 Mirai WS 服务端地址（ws:// 或 wss://）"
    }
    if (!CLIENT_ID.test(cfg.miraiWsClientId ?? "")) {
      return "Mirai 插件 clientId 只能含字母、数字、点、下划线或连字符，长度为 1 至 64"
    }
    if (!validToken(cfg.miraiWsToken ?? "", allowMask)) {
      return "Mirai token 至少 8 个可见 ASCII 字符，不能包含空白；请与插件 token 保持一致"
    }
    return null
  }
  if (
    !Number.isInteger(cfg.miraiWsPort) ||
    cfg.miraiWsPort < 1 ||
    cfg.miraiWsPort > 65535
  ) {
    return "Mirai WS 监听端口须为 1 至 65535 的整数"
  }
  const entries = Object.entries(cfg.miraiWsClients ?? {})
  if (entries.length === 0)
    return "请先添加至少一组 Mirai 接入端凭据，再启用通道"
  const tokens = new Set<string>()
  for (const [id, token] of entries) {
    if (!CLIENT_ID.test(id)) return "Mirai 接入端 clientId 格式无效"
    if (!validToken(token, allowMask)) {
      return "每个 Mirai 接入端 token 至少 8 个可见 ASCII 字符，不能包含空白"
    }
    if (!token.includes("•")) {
      if (tokens.has(token)) return "不同 Mirai 接入端必须使用不同 token"
      tokens.add(token)
    }
  }
  return null
}
