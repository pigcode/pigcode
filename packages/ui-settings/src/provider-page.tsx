// 服务提供方设置页：展示 Claude Code 检测结果与 provider 能力。
import type { ProviderCapabilities } from "@pigcode/contracts"
import { Badge, Button, useLocale, type MessageKey } from "@pigcode/ui-primitives"
import { SettingPage, SettingRow, SettingSection } from "./settings-page"

/** 页面展示用的 provider 摘要。 */
export interface ProviderSummary {
  id: string
  displayName: string
  status: "ready" | "unavailable"
  capabilities: ProviderCapabilities
}

/** Claude Code 只读检测结果；字段与 Host 的 ClaudeDetection 对齐。 */
export interface ProviderDetection {
  installed: boolean
  version: string | null
  loggedIn: boolean
  authMethod: string | null
  subscriptionType?: string | null | undefined
  /** 实际使用的可执行文件路径；仅用于诊断展示。 */
  command?: string | null | undefined
  error?: string | null | undefined
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

/** 渲染 Claude Code 检测分区；未检测到时返回 null。 */
function ClaudeSection({
  detection,
  onDetect,
}: {
  detection: ProviderDetection | null | undefined
  onDetect: (() => void | Promise<void>) | undefined
}) {
  const { t } = useLocale()
  if (!detection) return null

  return (
    <SettingSection title={t("settings.providers.claude")}>
      <SettingRow
        title={t("settings.providers.status")}
        description={detection.command ?? undefined}
        value={
          <Badge variant={detection.installed ? "ok" : "bad"}>
            {detection.installed
              ? t("settings.providers.installed")
              : t("settings.providers.notInstalled")}
          </Badge>
        }
      />
      <SettingRow
        title={t("settings.providers.version")}
        value={detection.version ?? t("settings.providers.unknown")}
      />
      <SettingRow
        title={t("settings.providers.login")}
        value={
          <Badge variant={detection.loggedIn ? "ok" : "bad"}>
            {detection.loggedIn
              ? t("settings.providers.loggedIn")
              : t("settings.providers.notLoggedIn")}
          </Badge>
        }
      />
      <SettingRow
        title={t("settings.providers.authMethod")}
        value={detection.authMethod ?? t("settings.providers.unknown")}
      />
      <SettingRow
        title={t("settings.providers.subscriptionType")}
        value={detection.subscriptionType ?? t("settings.providers.unknown")}
      />
      {detection.error ? (
        <SettingRow title={t("settings.providers.error")} description={detection.error} />
      ) : null}
      {onDetect ? (
        <SettingRow title={t("settings.providers.detect")}>
          <Button variant="secondary" onClick={() => void onDetect()}>
            {t("settings.providers.detect")}
          </Button>
        </SettingRow>
      ) : null}
    </SettingSection>
  )
}

/** 渲染 provider 列表与 Claude 检测状态；没有数据时显示空状态。 */
export function ProviderPage({
  providers,
  detection,
  onDetect,
}: {
  providers?: ProviderSummary[] | undefined
  detection?: ProviderDetection | null | undefined
  onDetect?: (() => void | Promise<void>) | undefined
}) {
  const { t } = useLocale()
  // 只传检测结果时不重复展示默认 fake provider。
  const list = providers ?? (detection ? [] : [fakeProvider])

  return (
    <SettingPage title={t("settings.providers")}>
      <ClaudeSection detection={detection} onDetect={onDetect} />
      {list.length === 0 && !detection ? (
        <div className="empty">{t("settings.providers.empty")}</div>
      ) : null}
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
