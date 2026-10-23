/** provider 能力字段到 locale 文案的映射，顺序固定。 */
import type { ProviderCapabilities } from "@pigcode/contracts"
import type { MessageKey } from "@pigcode/ui-primitives"

export const capabilityKeys: ReadonlyArray<{
  key: keyof ProviderCapabilities
  labelKey: MessageKey
}> = [
  { key: "streaming", labelKey: "settings.providers.capability.streaming" },
  { key: "approvals", labelKey: "settings.providers.capability.approvals" },
  { key: "questions", labelKey: "settings.providers.capability.questions" },
  { key: "plan", labelKey: "settings.providers.capability.plan" },
  { key: "resume", labelKey: "settings.providers.capability.resume" },
  { key: "fork", labelKey: "settings.providers.capability.fork" },
  { key: "rollback", labelKey: "settings.providers.capability.rollback" },
  { key: "checkpoint", labelKey: "settings.providers.capability.checkpoint" },
  { key: "subagents", labelKey: "settings.providers.capability.subagents" },
  { key: "mcp", labelKey: "settings.providers.capability.mcp" },
  { key: "images", labelKey: "settings.providers.capability.images" },
  { key: "usage", labelKey: "settings.providers.capability.usage" },
  { key: "modelCatalog", labelKey: "settings.providers.capability.modelCatalog" },
  { key: "nativeSessionId", labelKey: "settings.providers.capability.nativeSessionId" },
]
