/**
 * Agent 设置页：左边是全部实例的列表（每个 Agent 的默认实例在最前，其余实例跟在后面），
 * 右边是选中实例的详情卡片。新建实例走三步向导；列表底部是添加实例与安装 agent。
 * 布局参考主从两栏的设置页：左栏实例列表、右栏分节卡片，列表行带头像与状态。
 */
import { useEffect, useMemo, useState } from "react"
import { ChevronDown, Plus, RefreshCw } from "lucide-react"
import type {
  AgentInstance,
  AgentSettingsValues,
  AgentStatus,
  AgentSummary,
} from "@pigcode/contracts"
import {
  Badge,
  Button,
  EmptyState,
  EntityAvatar,
  InstallDialog,
  ListRow,
  Select,
  StatusDot,
  Switch,
  useLocale,
} from "@pigcode/ui-primitives"
import { AgentEditor } from "./agent-editor"
import type { PickPath } from "./agent-fields"
import { InstanceCreateWizard } from "./agent-instance-wizard"
import { allInstances, instanceLabel, instancesOf } from "./agent-instances"
import { instanceHeadline } from "./agent-status"

/** Agent 页的数据与操作；操作失败时抛错，页面展示原因。 */
export interface AgentsPageProps {
  agents: readonly AgentSummary[]
  /** 用户选择的默认 agent。 */
  defaultAgentId: string | null
  /** 用户选择的默认实例；为 null 时用默认 agent 的默认实例。 */
  defaultInstanceId?: string | null
  /** 按实例 id 的检测结果；缺少表示还在检测。 */
  statuses: Readonly<Record<string, AgentStatus | undefined>>
  detecting?: boolean
  onDetect: () => Promise<void>
  onSetEnabled: (agent: AgentSummary, enabled: boolean) => Promise<void>
  onSaveSettings: (
    agent: AgentSummary,
    instance: AgentInstance,
    values: AgentSettingsValues,
  ) => Promise<void>
  /** 新会话默认使用的实例；instanceId 为 null 表示自动。 */
  onSetDefault: (instanceId: string | null) => Promise<void>
  /** 新建实例；返回新实例的 id，页面据此切到它。 */
  onCreateInstance: (agent: AgentSummary, label: string, copyFrom: string | null) => Promise<string>
  onUpdateInstance: (
    agent: AgentSummary,
    instanceId: string,
    patch: { label?: string; enabled?: boolean },
  ) => Promise<void>
  onRemoveInstance: (agent: AgentSummary, instanceId: string) => Promise<void>
  onInstall: (spec: string) => Promise<void>
  onUninstall: (agent: AgentSummary) => Promise<void>
  onPickPath?: PickPath | undefined
  onOpenExternal?: ((url: string) => void) | undefined
}

/** 「自动」在 Select 里的值；实例 id 不会以冒号开头。 */
const AUTO = ":auto"

/** 列表里的一行：头像、实例名、实例 id 与状态；整行可点，右侧是启用开关。 */
function InstanceRow({
  agent,
  instance,
  status,
  selected,
  pending,
  onSelect,
  onSetEnabled,
}: {
  agent: AgentSummary
  instance: AgentInstance
  status: AgentStatus | undefined
  selected: boolean
  pending: boolean
  onSelect: () => void
  onSetEnabled: (enabled: boolean) => void
}) {
  const { t } = useLocale()
  const label = instanceLabel(agent, instance)
  const headline = instanceHeadline(agent, instance, status)
  return (
    <ListRow
      className="agent-row"
      selected={selected}
      button={{
        className: "agent-row-main",
        "aria-pressed": selected,
        "aria-label": t("agents.select").replace("{instance}", label),
        onClick: onSelect,
      }}
      leading={<EntityAvatar id={instance.instanceId} name={label} />}
      title={
        <span className="agent-row-title">
          <span className="truncate">{label}</span>
          {instance.isDefault ? <Badge>{t("agents.instance.default")}</Badge> : null}
          {agent.builtin && agent.pluginId ? <Badge>{t("agents.builtin")}</Badge> : null}
        </span>
      }
      description={
        <span className="agent-row-status" data-tone={headline.tone}>
          <StatusDot tone={headline.tone} />
          <span>{t(headline.label)}</span>
          {headline.detail ? (
            <span className="agent-row-detail truncate">· {headline.detail}</span>
          ) : null}
        </span>
      }
      actions={
        <Switch
          aria-label={t("agents.enable").replace("{agent}", label)}
          checked={agent.enabled && instance.enabled}
          disabled={pending}
          onCheckedChange={(checked) => onSetEnabled(checked)}
        />
      }
    />
  )
}

/** 渲染 Agent 设置页。 */
export function AgentsPage({
  agents,
  defaultAgentId,
  defaultInstanceId = null,
  statuses,
  detecting = false,
  onDetect,
  onSetEnabled,
  onSaveSettings,
  onSetDefault,
  onCreateInstance,
  onUpdateInstance,
  onRemoveInstance,
  onInstall,
  onUninstall,
  onPickPath,
  onOpenExternal,
}: AgentsPageProps) {
  const { t } = useLocale()
  const entries = useMemo(() => allInstances(agents), [agents])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [installOpen, setInstallOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 选中的实例不在了（删掉、插件停用）时退回第一个实例，右侧不留空白。
  const selected = entries.find((entry) => entry.instance.instanceId === selectedId) ?? entries[0]
  const selectedInstanceId = selected?.instance.instanceId ?? null
  useEffect(() => {
    if (selected && selected.instance.instanceId !== selectedId) {
      setSelectedId(selected.instance.instanceId)
    }
  }, [selected, selectedId])

  // 新会话实际会用的实例：用户选的实例优先；只选了 agent 时用它自己的默认实例。
  // 两个都没配时是「自动」，由 Host 按可用性挑。
  const sessionDefaultId = useMemo(() => {
    if (defaultInstanceId && entries.some((e) => e.instance.instanceId === defaultInstanceId)) {
      return defaultInstanceId
    }
    const agent = agents.find((item) => item.agentId === defaultAgentId)
    if (!agent) return null
    return instancesOf(agent).find((item) => item.isDefault)?.instanceId ?? agent.agentId
  }, [defaultInstanceId, defaultAgentId, entries, agents])

  // 默认选择器只列启用的实例：停用的实例新会话不会用到，选它没有意义。
  const defaultChoices = entries.filter(
    (entry) => entry.agent.enabled && entry.agent.registered && entry.instance.enabled,
  )

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
    <div className="page wide agents-page">
      <header className="page-head">
        <div>
          <h1>{t("settings.agents")}</h1>
          <p className="sub">{t("agents.sub")}</p>
        </div>
        <div className="actions">
          <Button
            size="sm"
            type="button"
            disabled={detecting}
            onClick={() => void run("detect", onDetect)}
          >
            <RefreshCw className={detecting ? "ic ic-sm spin" : "ic ic-sm"} aria-hidden="true" />
            {t("agents.detect")}
          </Button>
        </div>
      </header>

      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}

      {/* 新会话使用哪个实例：一行紧凑的选择器，自动时由 Host 挑第一个可用的。 */}
      <div className="agents-default">
        <div className="agents-default-label">
          <span>{t("agents.default.title")}</span>
          <span className="agent-muted">{t("agents.default.description")}</span>
        </div>
        <Select.Root
          value={sessionDefaultId ?? AUTO}
          onValueChange={(value) =>
            void run("default", () =>
              onSetDefault(value === AUTO || value === null ? null : String(value)),
            )
          }
        >
          <Select.Trigger className="input select-trigger" aria-label={t("agents.default.title")}>
            <Select.Value className="grow">
              {(value: string) => {
                if (value === AUTO) return t("agents.default.auto")
                const entry = defaultChoices.find((item) => item.instance.instanceId === value)
                return entry?.label ?? value
              }}
            </Select.Value>
            <ChevronDown className="ic ic-sm" aria-hidden="true" />
          </Select.Trigger>
          <Select.Portal>
            <Select.Positioner sideOffset={6} alignItemWithTrigger={false}>
              <Select.Popup>
                <Select.Item value={AUTO}>
                  <Select.ItemText>{t("agents.default.auto")}</Select.ItemText>
                </Select.Item>
                {defaultChoices.map((entry) => (
                  <Select.Item key={entry.instance.instanceId} value={entry.instance.instanceId}>
                    <Select.ItemText>{entry.label}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.Popup>
            </Select.Positioner>
          </Select.Portal>
        </Select.Root>
      </div>

      <div className="agents-layout">
        <aside className="agents-master" aria-label={t("agents.instances")}>
          <div className="agents-master-list">
            {entries.length === 0 ? (
              <EmptyState
                size="compact"
                title={t("agents.empty")}
                description={t("agents.emptyHint")}
              />
            ) : null}
            {entries.map((entry) => {
              const id = entry.instance.instanceId
              return (
                <InstanceRow
                  key={id}
                  agent={entry.agent}
                  instance={entry.instance}
                  status={statuses[id]}
                  selected={id === selectedInstanceId}
                  pending={pending === id}
                  onSelect={() => setSelectedId(id)}
                  onSetEnabled={(enabled) =>
                    void run(id, async () => {
                      if (entry.instance.isDefault) {
                        await onSetEnabled(entry.agent, enabled)
                      } else {
                        await onUpdateInstance(entry.agent, id, { enabled })
                      }
                    })
                  }
                />
              )
            })}
          </div>
          <button type="button" className="agents-add" onClick={() => setWizardOpen(true)}>
            <Plus className="ic ic-sm" aria-hidden="true" />
            {t("agents.instance.add")}
          </button>
          <button type="button" className="agents-add" onClick={() => setInstallOpen(true)}>
            <Plus className="ic ic-sm" aria-hidden="true" />
            {t("agents.install")}
          </button>
        </aside>

        <div className="agents-detail">
          {selected ? (
            <AgentEditor
              key={selected.instance.instanceId}
              agent={selected.agent}
              instance={selected.instance}
              status={statuses[selected.instance.instanceId]}
              defaultInstanceId={sessionDefaultId}
              onSave={(values) =>
                onSaveSettings(selected.agent, selected.instance, values).then(() => undefined)
              }
              onUpdateInstance={(instanceId, patch) =>
                onUpdateInstance(selected.agent, instanceId, patch)
              }
              onRemoveInstance={(instanceId) =>
                onRemoveInstance(selected.agent, instanceId).then(() => {
                  const remaining = instancesOf(selected.agent).filter(
                    (item) => item.instanceId !== instanceId,
                  )
                  setSelectedId(remaining[0]?.instanceId ?? null)
                })
              }
              onSetDefaultInstance={(instanceId) => onSetDefault(instanceId)}
              onUninstall={
                selected.agent.pluginId && !selected.agent.builtin
                  ? () => run(selected.agent.agentId, () => onUninstall(selected.agent))
                  : undefined
              }
              onPickPath={onPickPath}
              onOpenExternal={onOpenExternal}
            />
          ) : null}
        </div>
      </div>

      <InstanceCreateWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        agents={agents}
        agentId={selected?.agent.agentId ?? null}
        saving={pending !== null}
        run={(action) => run("create", action)}
        onCreateInstance={async (agent, label, copyFrom) => {
          const created = await onCreateInstance(agent, label, copyFrom)
          setSelectedId(created)
        }}
      />

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
    </div>
  )
}
