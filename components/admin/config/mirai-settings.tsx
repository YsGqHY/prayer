"use client"

import { useState } from "react"
import { X, Plus } from "lucide-react"
import { toast } from "sonner"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SectionCard } from "@/components/admin/section-card"
import { ChannelDot } from "@/components/channel-dot"

import type { ConfigForm } from "./use-config-form"

export function MiraiSettings({
  cfg,
  setCfg,
  miraiChannel,
  miraiClients,
  addMiraiClient,
  removeMiraiClient,
  updateMiraiToken,
}: Pick<
  ConfigForm,
  | "cfg"
  | "setCfg"
  | "miraiChannel"
  | "miraiClients"
  | "addMiraiClient"
  | "removeMiraiClient"
  | "updateMiraiToken"
>) {
  const [idDraft, setIdDraft] = useState("")
  const [tokenDraft, setTokenDraft] = useState("")

  function onAdd() {
    const err = addMiraiClient(idDraft, tokenDraft)
    if (err) {
      toast.error(err)
      return
    }
    setIdDraft("")
    setTokenDraft("")
  }

  const enabled = !!cfg.miraiWsEnabled
  const mode = cfg.miraiWsMode ?? "server"
  const noClients = miraiClients.length === 0
  const runningMode = miraiChannel?.detail?.match(/mode=(server|client)/)?.[1]

  return (
    <SectionCard
      title="mirai 通道"
      description="选择由哪一端发起连接。两种模式均支持消息上报、回复与查询。"
      action={
        miraiChannel ? (
          <ChannelDot ch={miraiChannel} />
        ) : !enabled ? (
          <span className="text-xs text-muted-foreground">未启用</span>
        ) : (
          <span className="text-xs text-muted-foreground">状态同步中…</span>
        )
      }
    >
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldLabel htmlFor="miraiWsEnabled">启用 mirai 通道</FieldLabel>
          <Switch
            id="miraiWsEnabled"
            checked={enabled}
            onCheckedChange={(v) => setCfg({ ...cfg, miraiWsEnabled: v })}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="miraiWsMode">Prayer 连接模式</FieldLabel>
          <Select
            items={{ server: "WS 服务端", client: "WS 客户端" }}
            value={mode}
            onValueChange={(value) => {
              if (value === "server" || value === "client") {
                setCfg({ ...cfg, miraiWsMode: value })
              }
            }}
          >
            <SelectTrigger id="miraiWsMode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="server">WS 服务端</SelectItem>
              <SelectItem value="client">WS 客户端</SelectItem>
            </SelectContent>
          </Select>
          <FieldDescription>
            {mode === "server"
              ? "Prayer WS 服务端 ← Mirai WS 客户端。插件设 wsMode: client，由 Mirai 主动连入。"
              : "Prayer WS 客户端 → Mirai WS 服务端。插件设 wsMode: server，由 Prayer 主动连接并自动重连。"}
            切换后点击“保存并生效”，另一模式的配置会保留。
          </FieldDescription>
          {runningMode && (
            <p className="text-xs text-muted-foreground">
              当前运行：WS {runningMode === "server" ? "服务端" : "客户端"}
              {runningMode !== mode ? "，切换尚未生效" : ""}
            </p>
          )}
        </Field>

        {miraiChannel?.lastError && (
          <p role="alert" className="text-sm break-words text-destructive">
            通道异常：{miraiChannel.lastError}
          </p>
        )}

        {mode === "client" ? (
          <>
            <Field>
              <FieldLabel htmlFor="miraiWsUrl">Mirai WS 服务端地址</FieldLabel>
              <Input
                id="miraiWsUrl"
                value={cfg.miraiWsUrl ?? ""}
                placeholder="ws://127.0.0.1:3003"
                className="font-mono"
                onChange={(e) => setCfg({ ...cfg, miraiWsUrl: e.target.value })}
              />
              <FieldDescription>
                填写 Prayer Bridge 插件的 WS 地址，不是 mirai-api-http。
                远程部署时插件需监听 Prayer 可访问的网卡地址。
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="miraiWsClientId">
                Mirai 插件 clientId
              </FieldLabel>
              <Input
                id="miraiWsClientId"
                value={cfg.miraiWsClientId ?? "mirai-1"}
                className="font-mono"
                onChange={(e) =>
                  setCfg({ ...cfg, miraiWsClientId: e.target.value })
                }
              />
              <FieldDescription>
                与插件 config.yml 中的 clientId 一致，用于校验连接的插件身份。
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="miraiWsToken">Mirai 插件 token</FieldLabel>
              <Input
                id="miraiWsToken"
                type="password"
                autoComplete="new-password"
                value={cfg.miraiWsToken ?? ""}
                className="font-mono"
                onChange={(e) =>
                  setCfg({ ...cfg, miraiWsToken: e.target.value })
                }
              />
              <FieldDescription>
                与插件 token 一致，至少 8 个可见 ASCII 字符，不含空白。
                已保存的掩码不改动则保留原值，不要复用后台 ADMIN_TOKEN。
              </FieldDescription>
            </Field>
          </>
        ) : (
          <>
            <Field>
              <FieldLabel htmlFor="miraiWsPort">WS 监听端口</FieldLabel>
              <Input
                id="miraiWsPort"
                type="number"
                min={1}
                max={65535}
                step={1}
                value={String(cfg.miraiWsPort ?? 3002)}
                className="font-mono"
                onChange={(e) =>
                  setCfg({ ...cfg, miraiWsPort: Number(e.target.value) })
                }
              />
              <FieldDescription>
                默认 3002。3000 是后台本身，3001 是 NapCat OneBot 的常用地址，
                同机部署时占用会导致启动失败（EADDRINUSE）。
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel>接入端凭据</FieldLabel>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={idDraft}
                  aria-label="新增接入端 clientId"
                  placeholder="clientId，如 mirai-1"
                  className="font-mono text-sm"
                  onChange={(e) => setIdDraft(e.target.value)}
                />
                <Input
                  value={tokenDraft}
                  type="password"
                  aria-label="新增接入端 token"
                  placeholder="token（至少 8 字符）"
                  className="font-mono text-sm"
                  autoComplete="off"
                  onChange={(e) => setTokenDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      onAdd()
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={onAdd}
                  className="shrink-0"
                >
                  <Plus data-icon="inline-start" />
                  添加
                </Button>
              </div>

              {miraiClients.length > 0 && (
                <div className="mt-2 flex flex-col gap-2">
                  {miraiClients.map(([id, token]) => (
                    <div key={id} className="flex items-center gap-2">
                      <span
                        title={id}
                        className="w-20 shrink-0 truncate font-mono text-xs sm:w-32"
                      >
                        {id}
                      </span>
                      <Input
                        value={token}
                        type="password"
                        aria-label={`${id} token`}
                        className="font-mono text-xs"
                        autoComplete="off"
                        onChange={(e) => updateMiraiToken(id, e.target.value)}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="shrink-0"
                        onClick={() => removeMiraiClient(id)}
                        aria-label={`删除 ${id}`}
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <FieldDescription>
                每台 mirai 一组 clientId + token，与插件 config.yml
                中的同名项一致。 已保存的 token 以掩码显示，不改动则保留原值。
                <strong className="text-foreground">
                  不要复用后台 ADMIN_TOKEN
                </strong>
                —— 那等于把管理权交给接入方。
              </FieldDescription>

              {enabled && noClients ? (
                <p className="mt-1 text-sm text-amber-800 dark:text-amber-200">
                  请先添加接入端凭据，再保存启用。无凭据时不开放监听端口。
                </p>
              ) : null}
            </Field>
          </>
        )}
        <p className="text-xs text-muted-foreground">
          跨公网请使用 <code>wss://</code>（反代加 TLS）；
          <code>ws://</code> 会明文传输 token 与聊天内容。
        </p>
      </FieldGroup>
    </SectionCard>
  )
}
