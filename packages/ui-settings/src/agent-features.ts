/** Agent 功能字段到 locale 文案的映射，顺序固定。 */
import type { AgentFeatures } from "@pigcode/contracts"
import type { MessageKey } from "@pigcode/ui-primitives"

export const agentFeatureKeys: ReadonlyArray<{
  key: keyof AgentFeatures
  labelKey: MessageKey
}> = [
  { key: "streaming", labelKey: "settings.agents.feature.streaming" },
  { key: "approvals", labelKey: "settings.agents.feature.approvals" },
  { key: "questions", labelKey: "settings.agents.feature.questions" },
  { key: "plan", labelKey: "settings.agents.feature.plan" },
  { key: "resume", labelKey: "settings.agents.feature.resume" },
  { key: "fork", labelKey: "settings.agents.feature.fork" },
  { key: "rollback", labelKey: "settings.agents.feature.rollback" },
  { key: "checkpoint", labelKey: "settings.agents.feature.checkpoint" },
  { key: "subagents", labelKey: "settings.agents.feature.subagents" },
  { key: "mcp", labelKey: "settings.agents.feature.mcp" },
  { key: "images", labelKey: "settings.agents.feature.images" },
  { key: "usage", labelKey: "settings.agents.feature.usage" },
  { key: "modelCatalog", labelKey: "settings.agents.feature.modelCatalog" },
  { key: "nativeSessionId", labelKey: "settings.agents.feature.nativeSessionId" },
]
