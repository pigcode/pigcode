/**
 * Agent 设置页（参照 t3code 的 Agent 设置页，外观和设置里其他页面一致）：
 * 上面是「新会话使用」，下面每个实例一张卡片（每个 Agent 的默认实例在前，其余实例跟在后面）。
 * 卡片头是品牌图标、名字、状态与登录的账号，右边是启用开关与展开箭头；点卡片头就地展开它的设置。
 * 新建实例走三步向导，安装 agent 走安装对话框，入口都在页头。
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
  AgentIcon,
  Badge,
  agentBrandOf,
  Button,
  EmptyState,
  InstallDialog,
  Select,
  StatusDot,
  Switch,
  useLocale,
} from "@pigcode/ui-primitives"
import { AgentEditor } from "./agent-editor"
import type { AgentModelInfo } from "./agent-models"
import type { PickPath } from "./agent-fields"
import { InstanceCreateWizard } from "./agent-instance-wizard"
import { allInstances, instancesOf, type AgentInstanceEntry } from "./agent-instances"
import { instanceHeadline } from "./agent-status"
import { SensitiveText } from "./sensitive-text"

export type { AgentModelInfo } from "./agent-models"

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
  /** 按实例 id 的模型目录；缺少表示还没读。展开实例时用 onLoadModels 读取。 */
  models?: Readonly<Record<string, readonly AgentModelInfo[] | undefined>>
  onLoadModels?: ((instanceId: string) => void) | undefined
  onDetect: () => Promise<void>
  onSetEnabled: (agent: AgentSummary, enabled: boolean) => Promise<void>
  onSaveSettings: (
    agent: AgentSummary,
    instance: AgentInstance,
    values: AgentSettingsValues,
  ) => Promise<void>
  /** 新会话默认使用的实例；instanceId 为 null 表示自动。 */
  onSetDefault: (instanceId: string | null) => Promise<void>
  /** 新建实例；返回新实例的 id，页面据此展开它。 */
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

/** 实例卡片的头部：整块是展开按钮，右边是启用开关（开关不跟着展开）。 */
function InstanceHead({
  entry,
  status,
  open,
  sessionDefault,
  pending,
  revealed,
  onToggle,
  onReveal,
  onSetEnabled,
}: {
  entry: AgentInstanceEntry
  status: AgentStatus | undefined
  open: boolean
  sessionDefault: boolean
  pending: boolean
  /** 账号邮箱是否显示原文；默认遮住。 */
  revealed: boolean
  onToggle: () => void
  onReveal: () => void
  onSetEnabled: (enabled: boolean) => void
}) {
  const { t } = useLocale()
  const { agent, instance, label } = entry
  const headline = instanceHeadline(agent, instance, status)
  const custom = !instance.isDefault
  const signedIn = headline.tone === "ready" && status?.authenticated === true
  return (
    <div className="agent-row" data-open={open || undefined}>
      {/* 整块卡片头可点：展开按钮铺满这一块，邮箱的显示按钮浮在它上面，不嵌套按钮。 */}
      <div className="agent-row-main">
        <button
          type="button"
          className="agent-row-hit"
          aria-expanded={open}
          aria-label={t("agents.select").replace("{instance}", label)}
          onClick={onToggle}
        />
        <span className="agent-tile" data-brand={agentBrandOf(agent.agentId) ?? undefined}>
          <AgentIcon
            agentId={agent.agentId}
            instanceId={instance.instanceId}
            name={label}
            size="lg"
          />
        </span>
        <span className="agent-row-text">
          <span className="agent-row-title">
            <span className="agent-row-name truncate">{label}</span>
            {custom ? <code className="agent-row-id">{instance.instanceId}</code> : null}
            {sessionDefault ? <Badge>{t("agents.instance.isSessionDefault")}</Badge> : null}
          </span>
          <span className="agent-row-status" data-tone={headline.tone}>
            <StatusDot tone={headline.tone} />
            <span className="agent-row-state">{t(headline.label)}</span>
            {signedIn && status?.email ? (
              <SensitiveText
                className="agent-row-email"
                value={status.email}
                revealed={revealed}
                onToggle={onReveal}
              />
            ) : null}
            {signedIn && status?.account ? (
              <span className="agent-plan truncate">{status.account}</span>
            ) : null}
          </span>
        </span>
        <ChevronDown className="ic ic-sm agent-row-caret" aria-hidden="true" />
      </div>
      <Switch
        aria-label={t("agents.enable").replace("{agent}", label)}
        checked={agent.enabled && instance.enabled}
        disabled={pending}
        onCheckedChange={(checked) => onSetEnabled(checked)}
      />
    </div>
  )
}

/** 渲染 Agent 设置页。 */
export function AgentsPage({
  agents,
  defaultAgentId,
  defaultInstanceId = null,
  statuses,
  detecting = false,
  models = {},
  onLoadModels,
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
  const [openId, setOpenId] = useState<string | null>(null)
  // 显示了邮箱原文的实例；卡片头与概览共用，离开页面后重新遮住。
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set())
  const toggleReveal = (id: string) =>
    setRevealed((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const [pending, setPending] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [installOpen, setInstallOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 展开的实例被删掉或随插件停用消失时收起。
  useEffect(() => {
    if (openId && !entries.some((entry) => entry.instance.instanceId === openId)) setOpenId(null)
  }, [entries, openId])
  // 展开时读一次它的模型目录。
  useEffect(() => {
    if (openId && models[openId] === undefined) onLoadModels?.(openId)
  }, [openId, models, onLoadModels])

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
  const openEntry = entries.find((entry) => entry.instance.instanceId === openId) ?? null

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
    <div className="page agents-page">
      <header className="page-head">
        <div>
          <h1>{t("settings.agents")}</h1>
          <p className="sub">{t("agents.sub")}</p>
        </div>
        <div className="actions">
          <Button size="sm" variant="ghost" type="button" onClick={() => setInstallOpen(true)}>
            {t("agents.install")}
          </Button>
          <Button size="sm" type="button" onClick={() => setWizardOpen(true)}>
            <Plus className="ic ic-sm" aria-hidden="true" />
            {t("agents.instance.add")}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            type="button"
            aria-label={t("agents.detect")}
            title={t("agents.detect")}
            disabled={detecting}
            onClick={() => void run("detect", onDetect)}
          >
            <RefreshCw className={detecting ? "ic ic-sm spin" : "ic ic-sm"} aria-hidden="true" />
          </Button>
        </div>
      </header>

      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}

      <section className="section">
        <div className="section-head">
          <h2>{t("agents.section.session")}</h2>
        </div>
        <div className="group">
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
              <Select.Trigger
                className="input select-trigger"
                aria-label={t("agents.default.title")}
              >
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
                      <Select.Item
                        key={entry.instance.instanceId}
                        value={entry.instance.instanceId}
                      >
                        <AgentIcon
                          agentId={entry.agent.agentId}
                          instanceId={entry.instance.instanceId}
                          name={entry.label}
                        />
                        <Select.ItemText>{entry.label}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.Popup>
                </Select.Positioner>
              </Select.Portal>
            </Select.Root>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>{t("agents.instances")}</h2>
        </div>
        <div className="agents-list" aria-label={t("agents.instances")}>
          {entries.length === 0 ? (
            <EmptyState
              size="compact"
              title={t("agents.empty")}
              description={t("agents.emptyHint")}
            />
          ) : null}
          {entries.map((entry) => {
            const id = entry.instance.instanceId
            const open = id === openId
            return (
              <div key={id} className="agent-card" data-open={open || undefined}>
                <InstanceHead
                  entry={entry}
                  status={statuses[id]}
                  open={open}
                  sessionDefault={id === sessionDefaultId}
                  pending={pending === id}
                  revealed={revealed.has(id)}
                  onToggle={() => setOpenId(open ? null : id)}
                  onReveal={() => toggleReveal(id)}
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
                {open && openEntry ? (
                  <AgentEditor
                    key={id}
                    agent={openEntry.agent}
                    instance={openEntry.instance}
                    status={statuses[id]}
                    revealed={revealed.has(id)}
                    onReveal={() => toggleReveal(id)}
                    models={models[id]}
                    defaultInstanceId={sessionDefaultId}
                    onSave={(values) =>
                      onSaveSettings(openEntry.agent, openEntry.instance, values).then(
                        () => undefined,
                      )
                    }
                    onUpdateInstance={(instanceId, patch) =>
                      onUpdateInstance(openEntry.agent, instanceId, patch)
                    }
                    onRemoveInstance={(instanceId) =>
                      onRemoveInstance(openEntry.agent, instanceId).then(() => setOpenId(null))
                    }
                    onSetDefaultInstance={(instanceId) => onSetDefault(instanceId)}
                    onUninstall={
                      openEntry.agent.pluginId && !openEntry.agent.builtin
                        ? () => run(openEntry.agent.agentId, () => onUninstall(openEntry.agent))
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
      </section>

      <InstanceCreateWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        agents={agents}
        agentId={openEntry?.agent.agentId ?? null}
        saving={pending !== null}
        run={(action) => run("create", action)}
        onCreateInstance={async (agent, label, copyFrom) => {
          const created = await onCreateInstance(agent, label, copyFrom)
          setOpenId(created)
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
