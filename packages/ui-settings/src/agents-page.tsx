/**
 * Agent 设置页，参照 t3code 的 Agent 设置页：「我的 Agent」是一张卡片，左边列出全部 Agent，
 * 右边是选中那一个的设置；卡片下面一组是新会话默认用哪个。
 * 打开时选中新会话用的那个，新建的会自动选中；切换时各自没保存的改动都留着。
 */
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react"
import { CircleArrowUp, Plus, RefreshCw } from "lucide-react"
import type {
  AgentInstance,
  AgentInstanceDraft,
  AgentSettingsValues,
  AgentStatus,
  AgentSummary,
  AgentCliUpdateState,
} from "@pigcode/contracts"
import {
  Button,
  EmptyState,
  ScrollArea,
  SearchField,
  SettingPage,
  SettingRow,
  SettingSection,
  useLocale,
} from "@pigcode/ui-primitives"
import type { ClaudeDefaults } from "./claude-compaction-settings"
import { AgentEditor } from "./agent-editor"
import type { AgentModelInfo } from "./agent-models"
import type { PickPath } from "./agent-fields"
import { InstanceCreateWizard } from "./agent-instance-wizard"
import type { RegistryActions } from "./agent-directory"
import { allInstances, hasInstanceSignIn } from "./agent-instances"
import { useInstanceEdits } from "./instance-edits"
import { InstanceItem } from "./agent-instance-head"
import { DefaultInstanceSelect } from "./agent-default-select"
import { AgentCliUpdate } from "./agent-cli-update"
import { AgentSetup, type AgentSetupActions } from "./agent-setup"

export type { AgentModelInfo } from "./agent-models"

/** 列表里的 Agent 到这个数量时，列表上方出现搜索框。 */
const FILTER_FROM = 8

/** 卡片里的一栏：自己滚动，滚动条浮在内容上，不占宽度，行之间的细线能画满一栏。 */
function Pane({ children }: { children: ReactNode }) {
  return (
    <ScrollArea.Root className="agents-pane">
      <ScrollArea.Viewport className="agents-pane-viewport">{children}</ScrollArea.Viewport>
      <ScrollArea.Scrollbar className="agents-pane-bar" orientation="vertical">
        <ScrollArea.Thumb className="agents-pane-thumb" />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  )
}

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
  /** 按实例 id 的模型目录；缺少表示还没读。选中一个实例时用 onLoadModels 读取。 */
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

  const defaultChoices = entries.filter(
    (entry) => entry.agent.enabled && entry.agent.registered && entry.instance.enabled,
  )
  const sameAgent = defaultChoices.filter((entry) => entry.agent.agentId === defaultAgentId)
  const selectedDefault =
    defaultChoices.find((entry) => entry.instance.instanceId === defaultInstanceId) ??
    sameAgent.find((entry) => entry.instance.isDefault) ??
    sameAgent[0]
  const sessionDefaultId = selectedDefault?.instance.instanceId ?? null

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState("")
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

  const selected =
    entries.find((entry) => entry.instance.instanceId === selectedId) ??
    entries.find((entry) => entry.instance.instanceId === sessionDefaultId) ??
    entries[0] ??
    null
  const activeId = selected?.instance.instanceId ?? null

  useEffect(() => {
    if (activeId && models[activeId] === undefined) onLoadModels?.(activeId)
  }, [activeId, models, onLoadModels])

  const instanceEdits = useInstanceEdits(selected?.instance)
  const query = filter.trim().toLowerCase()
  const visibleEntries = useMemo(
    () =>
      query
        ? entries.filter((entry) =>
            `${entry.label} ${entry.instance.instanceId} ${entry.agent.displayName}`
              .toLowerCase()
              .includes(query),
          )
        : entries,
    [entries, query],
  )
  const hasUpdates =
    Boolean(onUpdateCli) &&
    Object.values(cliUpdates).some((update) => update.available && update.canUpdate)
  const refreshing = detecting || checkingCliUpdates

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

  function toggleEnabled(entry: (typeof entries)[number], enabled: boolean) {
    const id = entry.instance.instanceId
    void run(id, async () => {
      if (entry.instance.isDefault && !entry.agent.accountSetup) {
        await onSetEnabled(entry.agent, enabled)
      } else {
        await onUpdateInstance(entry.agent, id, { enabled })
      }
    })
  }

  function updateAll() {
    if (!onUpdateCli) return
    void run("update-clis", async () => {
      const targets = new Map(
        Object.values(cliUpdates)
          .filter((update) => update.available && update.canUpdate)
          .map((update) => [update.target, update.instanceId]),
      )
      await Promise.all([...targets.values()].map(onUpdateCli))
    })
  }

  function onItemKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if ((event.key !== "ArrowDown" && event.key !== "ArrowUp") || visibleEntries.length < 2) return
    event.preventDefault()
    const nextIndex =
      (index + (event.key === "ArrowDown" ? 1 : -1) + visibleEntries.length) % visibleEntries.length
    const nextEntry = visibleEntries[nextIndex]!
    setSelectedId(nextEntry.instance.instanceId)
    document.getElementById("agent-select-" + nextEntry.instance.instanceId)?.focus()
  }

  return (
    <SettingPage title={t("settings.agents")} className="agents-page">
      <section className="section agents-section" aria-labelledby="agents-instances-title">
        <div className="section-head">
          <h2 id="agents-instances-title">{t("agents.instances")}</h2>
          <div className="section-actions">
            {hasUpdates ? (
              <Button
                size="sm"
                variant="ghost"
                type="button"
                disabled={checkingCliUpdates || pending !== null}
                onClick={updateAll}
              >
                <CircleArrowUp className="ic ic-sm" aria-hidden="true" />
                {t("agents.cli.updateAll")}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              type="button"
              aria-label={t("agents.detect")}
              title={t(onCheckCliUpdates ? "agents.cli.refresh" : "agents.detect")}
              disabled={refreshing}
              onClick={() =>
                void run("detect", async () => {
                  await Promise.all([onDetect(), onCheckCliUpdates?.()])
                })
              }
            >
              <RefreshCw className={refreshing ? "ic ic-sm spin" : "ic ic-sm"} aria-hidden="true" />
              <span aria-hidden="true">
                {t(refreshing ? "agents.status.checking" : "agents.detect")}
              </span>
            </Button>
          </div>
        </div>

        {error ? (
          <p className="agents-error-banner error-text" role="alert">
            {error}
          </p>
        ) : null}

        {entries.length === 0 ? (
          <div className="group agents-empty">
            <EmptyState
              size="compact"
              title={t("agents.empty")}
              description={t(
                agents.some((agent) => agent.registered && agent.enabled)
                  ? "agents.emptyConnect"
                  : "agents.emptyHint",
              )}
              actions={
                agents.some((agent) => agent.registered && agent.enabled) ? (
                  <Button size="md" variant="secondary" onClick={() => setWizardOpen(true)}>
                    <Plus className="ic ic-sm" aria-hidden="true" />
                    {t("agents.instance.add")}
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className="group agents-split">
            <div className="agents-rail">
              {entries.length >= FILTER_FROM ? (
                <div className="agents-filter">
                  <SearchField
                    size="compact"
                    value={filter}
                    onValueChange={setFilter}
                    placeholder={t("agents.filter")}
                    clearLabel={t("agents.directory.clear")}
                  />
                </div>
              ) : null}
              <Pane>
                <div className="agents-list" role="list" aria-label={t("agents.instances")}>
                  {visibleEntries.length === 0 ? (
                    <p className="agents-list-empty">{t("agents.filterEmpty")}</p>
                  ) : (
                    visibleEntries.map((entry, index) => {
                      const id = entry.instance.instanceId
                      return (
                        <InstanceItem
                          key={id}
                          entry={entry}
                          status={statuses[id]}
                          selected={id === activeId}
                          dirty={instanceEdits.isDirty(entry.instance)}
                          pending={pending === id}
                          update={cliUpdates[id]}
                          onShowUpdate={() =>
                            onShowUpdates ? onShowUpdates(id) : setSelectedId(id)
                          }
                          onSelect={() => setSelectedId(id)}
                          onKeyDown={(event) => onItemKeyDown(event, index)}
                          onSetEnabled={(enabled) => toggleEnabled(entry, enabled)}
                        />
                      )
                    })
                  )}
                </div>
                <button
                  type="button"
                  className="agents-add"
                  disabled={pending !== null}
                  onClick={() => setWizardOpen(true)}
                >
                  <span className="agents-add-icon" aria-hidden="true">
                    <Plus className="ic ic-sm" />
                  </span>
                  {t("agents.instance.add")}
                </button>
              </Pane>
            </div>

            {selected ? (
              <section
                className="agents-detail"
                id="agent-detail"
                aria-labelledby="agent-detail-title"
              >
                <Pane>
                  <AgentEditor
                    key={selected.instance.instanceId}
                    edits={instanceEdits}
                    idleDefaults={idleDefaults}
                    agent={selected.agent}
                    instance={selected.instance}
                    label={selected.label}
                    status={statuses[selected.instance.instanceId]}
                    revealed={revealed.has(selected.instance.instanceId)}
                    onReveal={() => toggleReveal(selected.instance.instanceId)}
                    models={models[selected.instance.instanceId]}
                    onSave={(values) =>
                      onSaveSettings(selected.agent, selected.instance, values).then(
                        () => undefined,
                      )
                    }
                    onUpdateInstance={(instanceId, patch) =>
                      onUpdateInstance(selected.agent, instanceId, patch)
                    }
                    onRemoveInstance={(instanceId) =>
                      onRemoveInstance(selected.agent, instanceId).then(() => {
                        instanceEdits.discard()
                        setSelectedId(null)
                      })
                    }
                    onPickPath={onPickPath}
                    setup={
                      hasInstanceSignIn(selected) && setupActions ? (
                        <AgentSetup
                          entry={selected}
                          status={statuses[selected.instance.instanceId]}
                          actions={setupActions}
                          update={cliUpdates[selected.instance.instanceId]}
                          onInstall={
                            onUpdateCli
                              ? () => onUpdateCli(selected.instance.instanceId)
                              : undefined
                          }
                          openExternal={onOpenExternal}
                        />
                      ) : null
                    }
                    cliUpdate={
                      onCheckCliUpdates && onUpdateCli ? (
                        <AgentCliUpdate
                          version={statuses[selected.instance.instanceId]?.version ?? null}
                          state={cliUpdates[selected.instance.instanceId]}
                          checking={checkingCliUpdates}
                          onCheck={() => onCheckCliUpdates(selected.instance.instanceId)}
                          onUpdate={() => onUpdateCli(selected.instance.instanceId)}
                        />
                      ) : null
                    }
                  />
                </Pane>
              </section>
            ) : null}
          </div>
        )}
      </section>

      {entries.length > 0 ? (
        <SettingSection title={t("agents.section.session")}>
          <SettingRow
            title={t("agents.default.title")}
            description={t("agents.default.description")}
          >
            <DefaultInstanceSelect
              choices={defaultChoices}
              value={sessionDefaultId}
              onChange={(instanceId) => void run("default", () => onSetDefault(instanceId))}
            />
          </SettingRow>
        </SettingSection>
      ) : null}

      {wizardOpen && (
        <InstanceCreateWizard
          onClose={(created) => {
            setWizardOpen(false)
            if (created) setSelectedId(created)
          }}
          agents={agents}
          agentId={selectedId ? (selected?.agent.agentId ?? null) : null}
          claudeDefault={idleDefaults?.value}
          onPickPath={onPickPath}
          registry={registry}
          setupActions={setupActions}
          openExternal={onOpenExternal}
          onCreateInstance={onCreateInstance}
        />
      )}
    </SettingPage>
  )
}
