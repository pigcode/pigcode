// 服务提供方设置页：M0-B 只展示 fake provider 的状态与能力。
import type { ProviderCapabilities } from "@pigcode/contracts"
import { Badge, useLocale, type MessageKey } from "@pigcode/ui-primitives"
import { SettingPage, SettingRow, SettingSection } from "./settings-page"

/** 页面展示用的 provider 摘要。 */
export interface ProviderSummary {
  id: string
  displayName: string
  status: "ready" | "unavailable"
  capabilities: ProviderCapabilities
}

/** fake provider 的固定能力，与 Host 端 FakeProviderDriver 保持一致。 */
export const fakeProviderCapabilities: ProviderCapabilities = {
  streaming: true,
  approvals: false,
  questions: false,
  plan: false,
  resume: false,
  fork: false,
  rollback: false,
  checkpoint: false,
  subagents: false,
  mcp: false,
  images: false,
  usage: false,
  modelCatalog: false,
  nativeSessionId: false,
}

/** M0-B 默认展示的 fake provider。 */
export const fakeProvider: ProviderSummary = {
  id: "fake",
  displayName: "Fake Provider",
  status: "ready",
  capabilities: fakeProviderCapabilities,
}

/** 能力字段到 locale 文案的映射，顺序固定。 */
const capabilityKeys: ReadonlyArray<{
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

/** 渲染 provider 列表；没有数据时显示空状态。 */
export function ProviderPage({ providers }: { providers?: ProviderSummary[] | undefined }) {
  const { t } = useLocale()
  const list = providers ?? [fakeProvider]

  if (list.length === 0) {
    return (
      <SettingPage title={t("settings.providers")}>
        <div className="empty">{t("settings.providers.empty")}</div>
      </SettingPage>
    )
  }

  return (
    <SettingPage title={t("settings.providers")}>
      {list.map((provider) => (
        <SettingSection key={provider.id} title={provider.displayName}>
          <SettingRow title={t("settings.providers.status")} description={provider.id}>
            <Badge variant={provider.status === "ready" ? "ok" : "bad"}>
              {provider.status === "ready"
                ? t("settings.providers.ready")
                : t("settings.providers.unavailable")}
            </Badge>
          </SettingRow>
          <SettingRow title={t("settings.providers.capabilities")}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-end" }}>
              {capabilityKeys.map((capability) => {
                const enabled = provider.capabilities[capability.key]
                return (
                  <Badge key={capability.key} variant={enabled ? "ok" : "neutral"}>
                    {t(capability.labelKey)}
                  </Badge>
                )
              })}
            </div>
          </SettingRow>
        </SettingSection>
      ))}
    </SettingPage>
  )
}
