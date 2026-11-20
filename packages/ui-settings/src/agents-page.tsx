/** Agent 设置页与实例的就地编辑。 */
import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, Plus, RefreshCw, X } from "lucide-react"
import type {
  AgentInstance,
  AgentInstanceDraft,
  AgentSettingsValues,
  AgentStatus,
  AgentSummary,
  AgentCliUpdateState,
} from "@pigcode/contracts"
import { AgentIcon, Button, EmptyState, Select, useLocale } from "@pigcode/ui-primitives"
import type { ClaudeDefaults } from "./claude-compaction-settings"
import { AgentEditor } from "./agent-editor"
import type { AgentModelInfo } from "./agent-models"
import type { PickPath } from "./agent-fields"
import { InstanceCreateWizard } from "./agent-instance-wizard"
import type { RegistryActions } from "./agent-directory"
import { allInstances, hasInstanceSignIn } from "./agent-instances"
import { useInstanceEdits } from "./instance-edits"
import { InstanceHead } from "./agent-instance-head"
import { AgentCliUpdate } from "./agent-cli-update"
import { AgentSetup, type AgentSetupActions } from "./agent-setup"

export type { AgentModelInfo } from "./agent-models"

/** Agent 页的数据与操作；操作失败时抛错，页面展示原因。 */
export interface AgentsPageProps {
  idleDefaults?: ClaudeDefaults | undefined
  cliUpdates?: Readonly<Record<string, AgentCliUpdateState>> | undefined
  checkingCliUpdates?: boolean | undefined
  onCheckCliUpdates?: ((instanceId?: string) => Promise<void>) | undefined
  onUpdateCli?: ((instanceId: string) => Promise<void>) | undefined
  setupActions?: AgentSetupActions | undefined
  registry?: RegistryActions | undefined
  onShowUpdates?: ((instanceId: string) => void) | undefined
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
  onCreateInstance: (draft: AgentInstanceDraft) => Promise<string>
  onUpdateInstance: (
    agent: AgentSummary,
    instanceId: string,
    patch: { label?: string; enabled?: boolean; accentColor?: string | null },
  ) => Promise<void>
  onRemoveInstance: (agent: AgentSummary, instanceId: string) => Promise<void>
  onPickPath?: PickPath | undefined
  onOpenExternal?: ((url: string) => void | Promise<void>) | undefined
}

/** 「自动」在 Select 里的值；实例 id 不会以冒号开头。 */
const AUTO = ":auto"

/** 渲染 Agent 设置页。 */
export function AgentsPage({
  idleDefaults,
  cliUpdates = {},
  checkingCliUpdates = false,
  onCheckCliUpdates,
  onUpdateCli,
  setupActions,
  registry,
  onShowUpdates,
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
  onPickPath,
  onOpenExternal,
}: AgentsPageProps) {
  const { t } = useLocale()
  const entries = useMemo(() => allInstances(agents), [agents])
  const [openId, setOpenId] = useState<string | null>(null)
  const detailTitle = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (openId) detailTitle.current?.scrollIntoView?.({ block: "nearest" })
  }, [openId])
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
  const [error, setError] = useState<string | null>(null)

  // 展开的实例被删掉或随插件停用消失时收起。
  useEffect(() => {
    if (openId && !entries.some((entry) => entry.instance.instanceId === openId)) setOpenId(null)
  }, [entries, openId])
  useEffect(() => {
    if (openId && models[openId] === undefined) onLoadModels?.(openId)
  }, [openId, models, onLoadModels])

  // 新会话实际会用的实例：用户选的实例优先；只选了 agent 时用它自己的默认实例。
  // 两个都没配时是「自动」，由 Host 按可用性挑。
  const defaultChoices = entries.filter(
    (entry) => entry.agent.enabled && entry.agent.registered && entry.instance.enabled,
  )
  const sameAgent = defaultChoices.filter((entry) => entry.agent.agentId === defaultAgentId)
  const selectedDefault =
    defaultChoices.find((entry) => entry.instance.instanceId === defaultInstanceId) ??
    sameAgent.find((entry) => entry.instance.isDefault) ??
    sameAgent[0]
  const sessionDefaultId = selectedDefault?.instance.instanceId ?? null
  const openEntry = entries.find((entry) => entry.instance.instanceId === openId) ?? null
  const instanceEdits = useInstanceEdits(openEntry?.instance)

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
        </div>
        <div className="actions">
          {onUpdateCli &&
          Object.values(cliUpdates).some((update) => update.available && update.canUpdate) ? (
            <Button
              size="lg"
              variant="ghost"
              type="button"
              aria-label={t("agents.cli.updateAll")}
              title={t("agents.cli.updateAll")}
              disabled={checkingCliUpdates || pending !== null}
              onClick={() =>
                void run("update-clis", async () => {
                  const targets = new Map(
                    Object.values(cliUpdates)
                      .filter((update) => update.available && update.canUpdate)
                      .map((update) => [update.target, update.instanceId]),
                  )
                  await Promise.all([...targets.values()].map(onUpdateCli))
                })
              }
            >
              {t("agents.cli.updateAllShort")}
            </Button>
          ) : null}
          <Button
            size="lg"
            type="button"
            disabled={pending !== null}
            onClick={() => setWizardOpen(true)}
          >
            <Plus className="ic ic-sm" aria-hidden="true" />
            {t("agents.instance.add")}
          </Button>
          <Button
            size="icon-lg"
            variant="ghost"
            type="button"
            aria-label={t("agents.detect")}
            title={t(onCheckCliUpdates ? "agents.cli.refresh" : "agents.detect")}
            disabled={detecting || checkingCliUpdates}
            onClick={() =>
              void run("detect", async () => {
                await Promise.all([onDetect(), onCheckCliUpdates?.()])
              })
            }
          >
            <RefreshCw
              className={detecting || checkingCliUpdates ? "ic ic-sm spin" : "ic ic-sm"}
              aria-hidden="true"
            />
          </Button>
        </div>
      </header>

      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}

      <section className="section">
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
                <Select.Value className="grow truncate">
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
                          accentColor={entry.instance.accentColor}
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
        <div className="section-head agent-list-head">
          <h2>{t("agents.instances")}</h2>
          {entries.length > 0 && (
            <>
              <span>{t("agents.directory.status")}</span>
              <span>{t("agents.directory.enabled")}</span>
            </>
          )}
        </div>
        <div className="agents-list" aria-label={t("agents.instances")}>
          {entries.length === 0 ? (
            <EmptyState
              size="compact"
              title={t("agents.empty")}
              description={t(
                agents.some((agent) => agent.registered && agent.enabled)
                  ? "agents.emptyConnect"
                  : "agents.emptyHint",
              )}
            />
          ) : null}
          {entries.map((entry) => {
            const id = entry.instance.instanceId
            const open = id === openId
            return (
              <div key={id} className="agent-card" data-open={open || undefined}>
                <InstanceHead
                  update={cliUpdates[id]}
                  onShowUpdate={() => (onShowUpdates ? onShowUpdates(id) : setOpenId(id))}
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
                      if (entry.instance.isDefault && !entry.agent.accountSetup) {
                        await onSetEnabled(entry.agent, enabled)
                      } else {
                        await onUpdateInstance(entry.agent, id, { enabled })
                      }
                    })
                  }
                />
              </div>
            )
          })}
        </div>
      </section>

      {openEntry && openId && (
        <section
          className="agents-inspector"
          id="agent-instance-details"
          aria-labelledby="agent-detail-name"
        >
          <header className="agent-detail-head">
            <AgentIcon
              agentId={openEntry.agent.agentId}
              instanceId={openId}
              name={openEntry.label}
              accentColor={openEntry.instance.accentColor}
            />
            <h2 ref={detailTitle} id="agent-detail-name">
              {openEntry.label}
            </h2>
            {!openEntry.instance.isDefault && (
              <span className="agent-muted">{openEntry.agent.displayName}</span>
            )}
            <Button
              size="icon-lg"
              variant="ghost"
              aria-label={t("agents.directory.closeDetails")}
              onClick={() => {
                document.getElementById("agent-select-" + openId)?.focus()
                setOpenId(null)
              }}
            >
              <X className="ic ic-sm" />
            </Button>
          </header>
          <AgentEditor
            key={openId}
            edits={instanceEdits}
            idleDefaults={idleDefaults}
            agent={openEntry.agent}
            instance={openEntry.instance}
            status={statuses[openId]}
            revealed={revealed.has(openId)}
            onReveal={() => toggleReveal(openId)}
            models={models[openId]}
            defaultInstanceId={sessionDefaultId}
            onSave={(values) =>
              onSaveSettings(openEntry.agent, openEntry.instance, values).then(() => undefined)
            }
            onUpdateInstance={(instanceId, patch) =>
              onUpdateInstance(openEntry.agent, instanceId, patch)
            }
            onRemoveInstance={(instanceId) =>
              onRemoveInstance(openEntry.agent, instanceId).then(() => {
                instanceEdits.discard()
                setOpenId((current) => (current === instanceId ? null : current))
              })
            }
            onSetDefaultInstance={(instanceId) => onSetDefault(instanceId)}
            onPickPath={onPickPath}
            onOpenExternal={onOpenExternal}
            setup={
              hasInstanceSignIn(openEntry) && setupActions ? (
                <AgentSetup
                  entry={openEntry}
                  status={statuses[openId]}
                  actions={setupActions}
                  update={cliUpdates[openId]}
                  onInstall={onUpdateCli ? () => onUpdateCli(openId) : undefined}
                  openExternal={onOpenExternal}
                />
              ) : null
            }
            cliUpdate={
              onCheckCliUpdates && onUpdateCli ? (
                <AgentCliUpdate
                  version={statuses[openId]?.version ?? null}
                  state={cliUpdates[openId]}
                  checking={checkingCliUpdates}
                  onCheck={() => onCheckCliUpdates(openId)}
                  onUpdate={() => onUpdateCli(openId)}
                />
              ) : null
            }
          />
        </section>
      )}
      {wizardOpen && (
        <InstanceCreateWizard
          onClose={(created) => {
            setWizardOpen(false)
            if (created) setOpenId(created)
          }}
          agents={agents}
          agentId={openEntry?.agent.agentId ?? null}
          claudeDefault={idleDefaults?.value}
          onPickPath={onPickPath}
          registry={registry}
          setupActions={setupActions}
          openExternal={onOpenExternal}
          onCreateInstance={onCreateInstance}
        />
      )}
    </div>
  )
}
