import { NextRequest, NextResponse } from "next/server"
import { setConfig } from "@/lib/config-store"
import { getAppContext } from "@/lib/app-context"
import { configPatchSchema, mergeConfigPatch } from "@/lib/config/patch"
import { miraiConfigError } from "@/lib/config/mirai"
import { getRuntime, defaultBuilders } from "@/lib/runtime"
import { ok, fail, maskConfig } from "@/lib/api"
import { chatsMissingKbNamespace } from "@/lib/channels/enabled-chats"

export async function GET(): Promise<NextResponse> {
  const { cfg } = getAppContext()
  // 漏配 kbNamespace 的生效会话会静默回落 default 分区(跨租户泄漏面),
  // 随配置一并返回供后台显式告警;单租户部署可忽略。
  return NextResponse.json(
    ok({
      ...maskConfig(cfg),
      kbNamespaceMissing: chatsMissingKbNamespace(cfg),
    })
  )
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => null)
  const parsed = configPatchSchema.safeParse(body)
  if (!parsed.success)
    return NextResponse.json(fail("参数非法"), { status: 400 })

  const { configRepo, cfg: current } = getAppContext()
  const patch = mergeConfigPatch(current, parsed.data)
  const miraiError = miraiConfigError({ ...current, ...patch })
  if (miraiError) return NextResponse.json(fail(miraiError), { status: 400 })
  const next = setConfig(configRepo, patch)

  const builders = await defaultBuilders()
  await getRuntime().reconfigure(next, builders)
  return NextResponse.json(ok(maskConfig(next)))
}
