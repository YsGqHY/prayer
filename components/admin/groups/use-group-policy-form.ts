import { useState } from "react"
import { triFrom } from "./policy-payload"
import type { Tri, Globals, Row } from "./types"

export function useGroupPolicyForm() {
  const [editing, setEditing] = useState<Row | null>(null)
  const [proactiveTri, setProactiveTri] = useState<Tri>("inherit")
  const [silenceMode, setSilenceMode] = useState<"inherit" | "custom">(
    "inherit"
  )
  const [silenceMin, setSilenceMin] = useState("3")
  const [handoffTri, setHandoffTri] = useState<Tri>("inherit")
  // 知识库分区:空串 = 继承(回落 default)
  const [kbNamespace, setKbNamespace] = useState("")

  function openEditor(r: Row, globals?: Globals) {
    setEditing(r)
    setProactiveTri(triFrom(r.policy.proactiveEnabled))
    if (r.policy.proactiveSilenceMs !== undefined) {
      setSilenceMode("custom")
      setSilenceMin(String(Math.round(r.policy.proactiveSilenceMs / 60_000)))
    } else {
      setSilenceMode("inherit")
      setSilenceMin(
        String(Math.round((globals?.proactiveSilenceMs ?? 180_000) / 60_000))
      )
    }
    setHandoffTri(triFrom(r.policy.notifyAdminOnHandoff))
    setKbNamespace(r.policy.kbNamespace ?? "")
  }

  function closeEditor() {
    setEditing(null)
  }

  return {
    editing,
    proactiveTri,
    setProactiveTri,
    silenceMode,
    setSilenceMode,
    silenceMin,
    setSilenceMin,
    handoffTri,
    setHandoffTri,
    kbNamespace,
    setKbNamespace,
    openEditor,
    closeEditor,
  }
}
