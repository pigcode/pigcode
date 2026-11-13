import { z } from "zod"

/** T3 Code 同等的四档运行权限；计划状态独立保存。 */
export const runtimeModeSchema = z.enum([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
])
export type RuntimeMode = z.infer<typeof runtimeModeSchema>
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access"

/** 兼容旧权限 id；迁移保留原有边界，未知值交给调用方拒绝。 */
export function normalizeRuntimeMode(mode: string, agentId?: string): RuntimeMode | null {
  const parsed = runtimeModeSchema.safeParse(mode)
  if (parsed.success) return parsed.data
  switch (mode) {
    case "workspace-write":
      return agentId === "claude" ? "approval-required" : "auto-accept-edits"
    case "accept-edits":
      return "auto-accept-edits"
    case "danger-full-access":
      return "full-access"
    case "read-only":
    case "dontAsk":
    case "plan":
      return "approval-required"
    default:
      return null
  }
}

/** 没有接入统一协议的旧插件仍使用原有字符串；Auto 回退到监督审批。 */
export function legacyPermissionMode(mode: RuntimeMode): string {
  switch (mode) {
    case "approval-required":
    case "auto":
      return "read-only"
    case "auto-accept-edits":
      return "workspace-write"
    case "full-access":
      return "danger-full-access"
  }
}
