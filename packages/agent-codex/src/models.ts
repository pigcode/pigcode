/** 把 model/list 的未知响应收窄为 Pigcode 的模型条目。 */
import type { ReasoningEffort } from "@pigcode/contracts"
import { asReasoningEffort, type AgentModelInfo } from "@pigcode/plugin-sdk"

/** Codex 模型条目；思考深度来自 supportedReasoningEfforts / defaultReasoningEffort。 */
export type CodexModelInfo = AgentModelInfo

/** supportedReasoningEfforts 既可能是字符串数组，也可能是 { reasoningEffort } 对象数组。 */
function parseEfforts(value: unknown): ReasoningEffort[] {
  if (!Array.isArray(value)) return []
  const efforts: ReasoningEffort[] = []
  for (const entry of value) {
    const raw =
      typeof entry === "object" && entry !== null
        ? ((entry as Record<string, unknown>).reasoningEffort ??
          (entry as Record<string, unknown>).effort)
        : entry
    const effort = asReasoningEffort(raw)
    if (effort && !efforts.includes(effort)) efforts.push(effort)
  }
  return efforts
}

/** Codex 快速模式对应的服务档 id。 */
export const FAST_SERVICE_TIER = "fast"

/** 模型是否有 fast 服务档：新协议是 serviceTiers 对象数组，旧协议是 additionalSpeedTiers 字符串数组。 */
function hasFastTier(model: Record<string, unknown>): boolean {
  const tiers = Array.isArray(model.serviceTiers)
    ? model.serviceTiers.map((tier) =>
        typeof tier === "object" && tier !== null ? (tier as Record<string, unknown>).id : tier,
      )
    : Array.isArray(model.additionalSpeedTiers)
      ? model.additionalSpeedTiers
      : []
  return tiers.includes(FAST_SERVICE_TIER)
}

/** 兼容 data/models 两种列表包裹，并跳过缺少 id 的条目。 */
export function parseCodexModels(value: unknown): CodexModelInfo[] {
  if (typeof value !== "object" || value === null) return []
  const record = value as Record<string, unknown>
  const raw = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : []
  const result: CodexModelInfo[] = []
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue
    const model = item as Record<string, unknown>
    const id =
      typeof model.id === "string" ? model.id : typeof model.model === "string" ? model.model : null
    if (!id) continue
    const entry: CodexModelInfo = {
      id,
      displayName:
        typeof model.displayName === "string"
          ? model.displayName
          : typeof model.name === "string"
            ? model.name
            : id,
      isDefault: model.isDefault === true,
    }
    if (typeof model.description === "string" && model.description) {
      entry.description = model.description
    }
    const efforts = parseEfforts(model.supportedReasoningEfforts)
    if (efforts.length > 0) {
      entry.efforts = efforts
      entry.defaultEffort = asReasoningEffort(model.defaultReasoningEffort)
    }
    if (hasFastTier(model)) entry.fast = true
    result.push(entry)
  }
  return result
}
