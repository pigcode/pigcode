// Agent 设置页：默认 agent、已安装的 agent 列表（状态与启用开关），点开一项编辑它的设置。
import { useState } from "react"
import { ChevronDown, Plus, RefreshCw } from "lucide-react"
import type { AgentSummary, ProviderSettingsValues, ProviderStatus } from "@pigcode/contracts"
import {
  Badge,
  Button,
  EntityAvatar,
  InstallDialog,
  ListRow,
  Select,
  SettingPage,
  SettingRow,
  SettingSection,
  Switch,
  useLocale,
} from "@pigcode/ui-primitives"
import { AgentEditor } from "./agent-editor"
import type { PickPath } from "./agent-fields"
import { agentHeadline } from "./agent-status"

/** Agent 页的数据与操作；操作失败时抛错，页面展示原因。 */
export interface AgentsPageProps {
  agents: readonly AgentSummary[]
  defaultProviderId: string | null
  /** 按 provider id 的检测结果；缺少表示还在检测。 */
  statuses: Readonly<Record<string, ProviderStatus | undefined>>
  detecting?: boolean
  onDetect: () => Promise<void>
  onSetEnabled: (agent: AgentSummary, enabled: boolean) => Promise<void>
  onSaveSettings: (agent: AgentSummary, values: ProviderSettingsValues) => Promise<void>
  onSetDefault: (providerId: string | null) => Promise<void>
  onInstall: (spec: string) => Promise<void>
  onUninstall: (agent: AgentSummary) => Promise<void>
  onPickPath?: PickPath | undefined
  onOpenExternal?: ((url: string) => void) | undefined
}

/** 「自动」在 Select 里的值；provider id 不会以冒号开头。 */
const AUTO = ":auto"

/** 列表里的一行：头像、名称、徽标、状态与启用开关；整行可点开编辑区。 */
function AgentRow({
  agent,
  status,
  expanded,
  pending,
  onToggle,
  onSetEnabled,
}: {
  agent: AgentSummary
  status: ProviderStatus | undefined
  expanded: boolean
  pending: boolean
  onToggle: () => void
  onSetEnabled: (enabled: boolean) => void
}) {
  const { t } = useLocale()
  const headline = agentHeadline(agent, status)
  return (
    <ListRow
      className="ext-row"
      data-expanded={expanded || undefined}
      button={{
        className: "ext-row-main",
        "aria-expanded": expanded,
        "aria-label": t("agents.expand").replace("{agent}", agent.displayName),
        onClick: onToggle,
      }}
      leading={<EntityAvatar id={agent.providerId} name={agent.displayName} />}
      title={
        <span className="ext-row-title">
          <span className="truncate">{agent.displayName}</span>
          {agent.builtin && agent.pluginId ? <Badge>{t("agents.builtin")}</Badge> : null}
          {agent.version ? <span className="ext-version">{agent.version}</span> : null}
        </span>
      }
      description={
        <span className="ext-row-status" data-tone={headline.tone}>
          <span className="ext-dot" aria-hidden="true" />
          <span>{t(headline.label)}</span>
          {headline.detail ? (
            <span className="ext-row-detail truncate">· {headline.detail}</span>
          ) : null}
        </span>
      }
      meta={<ChevronDown className="ic ic-sm ext-chevron" aria-hidden="true" />}
      actions={
        agent.pluginId ? (
          <Switch
            aria-label={t("agents.enable").replace("{agent}", agent.displayName)}
            checked={agent.enabled}
            disabled={pending}
            onCheckedChange={(checked) => onSetEnabled(checked)}
          />
        ) : null
      }
    />
  )
}

/** 渲染 Agent 设置页。 */
export function AgentsPage({
  agents,
  defaultProviderId,
  statuses,
  detecting = false,
  onDetect,
  onSetEnabled,
  onSaveSettings,
  onSetDefault,
  onInstall,
  onUninstall,
  onPickPath,
  onOpenExternal,
}: AgentsPageProps) {
  const { t } = useLocale()
  const [expanded, setExpanded] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [installOpen, setInstallOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selectable = agents.filter((agent) => agent.enabled && agent.registered)
  // 默认 agent 停用或不在了时，新会话按“自动”挑选；选择框显示实际生效的那一项。
  const effectiveDefault = selectable.some((agent) => agent.providerId === defaultProviderId)
    ? defaultProviderId
    : null

  async function run(key: string, action: () => Promise<void>): Promise<void> {
    setPending(key)
    setError(null)
    try {
      await action()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(t("agents.failed").replace("{reason}", message))
    } finally {
      setPending(null)
    }
  }

  return (
    <SettingPage
      title={t("settings.providers")}
      sub={t("agents.sub")}
      actions={
        <>
          <Button
            size="sm"
            type="button"
            disabled={detecting}
            onClick={() => void run("detect", onDetect)}
          >
            <RefreshCw className={detecting ? "ic ic-sm spin" : "ic ic-sm"} aria-hidden="true" />
            {t("agents.detect")}
          </Button>
          <Button size="sm" variant="primary" type="button" onClick={() => setInstallOpen(true)}>
            <Plus className="ic ic-sm" aria-hidden="true" />
            {t("agents.install")}
          </Button>
        </>
      }
    >
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
      <SettingSection title={t("agents.default")}>
        <SettingRow title={t("agents.default.title")} description={t("agents.default.description")}>
          <Select.Root
            value={effectiveDefault ?? AUTO}
            onValueChange={(value) =>
              void run("default", () =>
                onSetDefault(value === AUTO || value === null ? null : String(value)),
              )
            }
          >
            <Select.Trigger className="input agent-select" aria-label={t("agents.default.title")}>
              <Select.Value className="grow">
                {(value: string) =>
                  value === AUTO
                    ? t("agents.default.auto")
                    : (agents.find((agent) => agent.providerId === value)?.displayName ?? value)
                }
              </Select.Value>
              <ChevronDown className="ic ic-sm" aria-hidden="true" />
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner sideOffset={6} alignItemWithTrigger={false}>
                <Select.Popup>
                  <Select.Item value={AUTO}>
                    <Select.ItemText>{t("agents.default.auto")}</Select.ItemText>
                  </Select.Item>
                  {selectable.map((agent) => (
                    <Select.Item key={agent.providerId} value={agent.providerId}>
                      <Select.ItemText>{agent.displayName}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </SettingRow>
      </SettingSection>
      <section className="section">
        <div className="section-head">
          <h2>{t("agents.list")}</h2>
        </div>
        {agents.length === 0 ? (
          <div className="empty">{t("agents.empty")}</div>
        ) : (
          <div className="group ext-list">
            {agents.map((agent) => {
              const open = expanded === agent.providerId
              return (
                <div className="ext-item" key={agent.providerId}>
                  <AgentRow
                    agent={agent}
                    status={statuses[agent.providerId]}
                    expanded={open}
                    pending={pending === agent.providerId}
                    onToggle={() => setExpanded(open ? null : agent.providerId)}
                    onSetEnabled={(enabled) =>
                      void run(agent.providerId, () => onSetEnabled(agent, enabled))
                    }
                  />
                  {open ? (
                    <AgentEditor
                      agent={agent}
                      status={statuses[agent.providerId]}
                      onSave={(values) => onSaveSettings(agent, values)}
                      onUninstall={
                        agent.pluginId && !agent.builtin
                          ? () => run(agent.providerId, () => onUninstall(agent))
                          : undefined
                      }
                      onPickPath={onPickPath}
                      onOpenExternal={onOpenExternal}
                    />
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </section>
      <InstallDialog
        open={installOpen}
        onOpenChange={setInstallOpen}
        onInstall={onInstall}
        inputId="agent-install-spec"
        labels={{
          close: t("common.close"),
          title: t("agents.install.title"),
          description: t("agents.install.description"),
          spec: t("agents.install.spec"),
          placeholder: t("agents.install.placeholder"),
          chooseFolder: t("agents.install.chooseFolder"),
          trust: t("agents.install.trust"),
          cancel: t("agents.install.cancel"),
          submit: t("agents.install.submit"),
          installing: t("plugins.installing"),
          failed: t("agents.failed"),
        }}
        {...(onPickPath ? { onPickFolder: () => onPickPath("directory") } : {})}
      />
    </SettingPage>
  )
}
