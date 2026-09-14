import { NextRequest, NextResponse } from "next/server"
import { getAppContext } from "@/lib/app-context"
import { DIM } from "@/lib/db/index"
import { ok, fail } from "@/lib/api"

// 向量库预览:无 doc → 全库统计(行含 namespace);带 ?doc=xxx → 该 doc 的分块内容。
// ?ns= 限定分区:不同分区可有同名 doc,不限定会把它们混在一起显示。
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const { repo } = getAppContext()
    const doc = req.nextUrl.searchParams.get("doc")
    const ns = req.nextUrl.searchParams.get("ns")?.trim() || undefined
    if (doc) return NextResponse.json(ok(repo.kbChunksByDoc(doc, ns)))
    const totals = repo.kbTotals()
    return NextResponse.json(
      ok({ ...totals, dim: DIM, docs: repo.kbDocStats() })
    )
  } catch (err) {
    return NextResponse.json(
      fail(err instanceof Error ? err.message : String(err)),
      { status: 500 }
    )
  }
}
