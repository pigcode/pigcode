import { permissionModeSchema, type Thread } from "@pigcode/contracts"

/**
 * 从 thread.updated 的 payload 中读出线程字段的变化：标题、权限模式、切换后的 agent 与模型。
 * 没有可用字段时返回 null。
 */
export function threadPatchFromEvent(payload: unknown): Partial<Thread> | null {
  if (typeof payload !== "object" || payload === null) return null
  const value = payload as {
    title?: unknown
    permissionMode?: unknown
    planMode?: unknown
    agentId?: unknown
    instanceId?: unknown
    modelId?: unknown
  }
  const patch: Partial<Thread> = {}
  if (typeof value.title === "string" && value.title.trim().length > 0) patch.title = value.title
  if (
    typeof value.permissionMode === "string" &&
    permissionModeSchema.safeParse(value.permissionMode).success
  ) {
    patch.permissionMode =
      value.permissionMode === "plan" ? "workspace-write" : value.permissionMode
    if (value.permissionMode === "plan") patch.planMode = true
  }
  if (typeof value.agentId === "string" && value.agentId.length > 0) {
    patch.lastAgentId = value.agentId
    // 旧事件没有 instanceId：按 Agent 的默认实例处理。
    patch.lastInstanceId =
      typeof value.instanceId === "string" && value.instanceId.length > 0
        ? value.instanceId
        : value.agentId
    patch.lastModelId = typeof value.modelId === "string" ? value.modelId : null
  }
  if (typeof value.planMode === "boolean") patch.planMode = value.planMode
  return Object.keys(patch).length > 0 ? patch : null
}
