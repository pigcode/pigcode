// 服务提供方设置页：按 provider 分区展示只读检测结果与能力。
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

/** 页面里一个 provider 的检测状态；Claude 与 Codex 共用同一结构。 */
export interface ProviderStatus {
  id: string
  displayName: string
  installed: boolean
  version: string | null
  loggedIn: boolean
  authMethod: string | null
  subscriptionType?: string | null | undefined
  /** 实际使用的可执行文件路径；仅用于诊断展示。 */
  command?: string | null | undefined
  error?: string | null | undefined
  /** 能力来自 provider.list；检测阶段可能尚未拿到。 */
  capabilities?: ProviderCapabilities | undefined
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

/** 把旧的单 provider 检测结果归一化为分区数据。 */
function fromDetection(
  detection: ProviderDetection,
  displayName: string,
  capabilities: ProviderCapabilities | undefined,
): ProviderStatus {
  return {
    id: "claude",
    displayName,
    installed: detection.installed,
    version: detection.version,
    loggedIn: detection.loggedIn,
    authMethod: detection.authMethod,
    subscriptionType: detection.subscriptionType ?? null,
    command: detection.command ?? null,
    error: detection.error ?? null,
    ...(capabilities ? { capabilities } : {}),
  }
}

/** 渲染单个 provider 的检测与能力分区。 */
function ProviderSection({ provider }: { provider: ProviderStatus }) {
  const { t } = useLocale()

  return (
    <SettingSection title={provider.displayName}>
      <SettingRow
        title={t("settings.providers.status")}
        description={provider.command ?? undefined}
        value={
          <Badge variant={provider.installed ? "ok" : "bad"}>
            {provider.installed
              ? t("settings.providers.installed")
              : t("settings.providers.notInstalled")}
          </Badge>
        }
      />
      <SettingRow
        title={t("settings.providers.version")}
        value={provider.version ?? t("settings.providers.unknown")}
      />
      <SettingRow
        title={t("settings.providers.login")}
        value={
          <Badge variant={provider.loggedIn ? "ok" : "bad"}>
            {provider.loggedIn
              ? t("settings.providers.loggedIn")
              : t("settings.providers.notLoggedIn")}
          </Badge>
        }
      />
      <SettingRow
        title={t("settings.providers.authMethod")}
        value={provider.authMethod ?? t("settings.providers.unknown")}
      />
      {provider.subscriptionType ? (
        <SettingRow
          title={t("settings.providers.subscriptionType")}
          value={provider.subscriptionType}
        />
      ) : null}
      {provider.error ? (
        <SettingRow title={t("settings.providers.error")} description={provider.error} />
      ) : null}
      {provider.capabilities ? (
        <SettingRow title={t("settings.providers.capabilities")}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-end" }}>
            {capabilityKeys.map((capability) => {
              const enabled = provider.capabilities?.[capability.key] === true
              return (
                <Badge key={capability.key} variant={enabled ? "ok" : "neutral"}>
                  {t(capability.labelKey)}
                </Badge>
              )
            })}
          </div>
        </SettingRow>
      ) : null}
    </SettingSection>
  )
}

/** 渲染 provider 列表；没有数据时显示空状态。 */
export function ProviderPage({
  providers,
  detection,
  onDetect,
}: {
  providers?: ProviderStatus[] | undefined
  /** 兼容旧的单 provider 调用方式；providers 非空时忽略。 */
  detection?: ProviderDetection | null | undefined
  onDetect?: (() => void | Promise<void>) | undefined
}) {
  const { t } = useLocale()
  const list = providers && providers.length > 0 ? providers : []
  const rows =
    list.length > 0
      ? list
      : detection
        ? [fromDetection(detection, t("settings.providers.claude"), undefined)]
        : []

  return (
    <SettingPage title={t("settings.providers")}>
      {rows.length === 0 ? (
        <div className="empty">{t("settings.providers.empty")}</div>
      ) : (
        rows.map((provider) => <ProviderSection key={provider.id} provider={provider} />)
      )}
      {onDetect ? (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button variant="secondary" onClick={() => void onDetect()}>
            {t("settings.providers.detect")}
          </Button>
        </div>
      ) : null}
    </SettingPage>
  )
}
