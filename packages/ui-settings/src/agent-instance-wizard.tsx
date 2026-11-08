/**
 * 新建实例的向导：选择 Agent → 起名字 → 选复制来源。三步都在一个对话框里，
 * 步骤条可以点回已经填过的步骤。
 */
import { useEffect, useMemo, useState } from "react"
import { Check } from "lucide-react"
import type { AgentSummary } from "@pigcode/contracts"
import {
  Button,
  Dialog,
  EntityAvatar,
  Input,
  ListRow,
  SearchField,
  useLocale,
} from "@pigcode/ui-primitives"
import { instanceLabel, instancesOf } from "./agent-instances"

/** 向导的三步；数组顺序就是步骤条的显示顺序。 */
const STEPS = ["agent", "identity", "config"] as const
type Step = (typeof STEPS)[number]

/** 每一步在步骤条上的名字。 */
const STEP_LABEL = {
  agent: "agents.instance.step.agent",
  identity: "agents.instance.step.identity",
  config: "agents.instance.step.config",
} as const

/** 复制来源用「默认实例」表示 agent 的默认实例；实例 id 不会是这个值。 */
const DEFAULT_SOURCE = ""

export interface InstanceCreateWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 可选的 Agent；停用或没注册的不会列出来。 */
  agents: readonly AgentSummary[]
  /** 打开时预选的 Agent，通常是设置页里正在看的那个。 */
  agentId?: string | null
  saving: boolean
  /** 执行一次会写 Host 的操作：期间禁用按钮，失败时把原因写进提示。 */
  run: (action: () => Promise<void>) => Promise<void>
  onCreateInstance: (agent: AgentSummary, label: string, copyFrom: string | null) => Promise<void>
}

/** 渲染新建实例的向导。 */
export function InstanceCreateWizard({
  open,
  onOpenChange,
  agents,
  agentId = null,
  saving,
  run,
  onCreateInstance,
}: InstanceCreateWizardProps) {
  const { t } = useLocale()
  const [step, setStep] = useState<Step>("agent")
  const [query, setQuery] = useState("")
  const [pickedId, setPickedId] = useState<string | null>(null)
  const [label, setLabel] = useState("")
  const [source, setSource] = useState(DEFAULT_SOURCE)

  // 每次打开都从第一步开始，沿用设置页里正在看的 Agent。
  useEffect(() => {
    if (!open) return
    setStep("agent")
    setQuery("")
    setPickedId(agentId)
    setLabel("")
    setSource(DEFAULT_SOURCE)
  }, [open, agentId])

  const selectable = useMemo(
    () => agents.filter((agent) => agent.enabled && agent.registered),
    [agents],
  )
  const picked = selectable.find((agent) => agent.agentId === pickedId) ?? null
  const matches = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return selectable
    return selectable.filter((agent) => agent.displayName.toLowerCase().includes(keyword))
  }, [selectable, query])
  const sources = picked ? instancesOf(picked) : []
  const trimmed = label.trim()

  /** 下一步可不可以走：第一步要有选中的 Agent，第二步要有名字。 */
  function canAdvance(from: Step): boolean {
    if (from === "agent") return picked !== null
    if (from === "identity") return trimmed.length > 0
    return true
  }

  function create(): void {
    if (!picked || !trimmed) return
    void run(async () => {
      await onCreateInstance(picked, trimmed, source === DEFAULT_SOURCE ? null : source)
      onOpenChange(false)
    })
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        className="instance-wizard"
        title={t("agents.instance.addTitle")}
        description={t("agents.instance.addDescription")}
        closeLabel={t("common.close")}
        closeDisabled={saving}
      >
        <Dialog.Body>
          <ol className="wizard-steps" aria-label={t("agents.instance.steps")}>
            {STEPS.map((item, index) => {
              const current = item === step
              const done = STEPS.indexOf(step) > index
              return (
                <li key={item} className="wizard-step" data-current={current || undefined}>
                  <button
                    type="button"
                    className="wizard-step-btn"
                    aria-current={current ? "step" : undefined}
                    disabled={saving || (!done && !current)}
                    onClick={() => setStep(item)}
                  >
                    <span className="wizard-step-mark" data-done={done || undefined}>
                      {done ? <Check className="ic ic-sm" aria-hidden="true" /> : index + 1}
                    </span>
                    {t(STEP_LABEL[item])}
                  </button>
                </li>
              )
            })}
          </ol>

          {step === "agent" ? (
            <div className="wizard-pane">
              <SearchField
                value={query}
                onValueChange={setQuery}
                placeholder={t("agents.instance.search")}
              />
              {matches.length === 0 ? (
                <p className="agent-muted">{t("agents.instance.noAgents")}</p>
              ) : (
                <div className="wizard-agents" role="listbox" aria-label={t("agents.list")}>
                  {matches.map((agent) => {
                    const selected = agent.agentId === pickedId
                    return (
                      <button
                        key={agent.agentId}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className="wizard-agent"
                        onClick={() => setPickedId(agent.agentId)}
                      >
                        <EntityAvatar id={agent.agentId} name={agent.displayName} />
                        <span className="wizard-agent-text">
                          <span className="truncate">{agent.displayName}</span>
                          <span className="agent-muted truncate">
                            {agent.version ??
                              t("agents.instance.count").replace(
                                "{count}",
                                String(instancesOf(agent).length),
                              )}
                          </span>
                        </span>
                        {selected ? <Check className="ic ic-sm" aria-hidden="true" /> : null}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          ) : null}

          {step === "identity" && picked ? (
            <div className="wizard-pane">
              <div className="wizard-picked">
                <EntityAvatar id={picked.agentId} name={picked.displayName} size="sm" />
                <span>{picked.displayName}</span>
              </div>
              <div className="field">
                <label className="label" htmlFor="instance-wizard-label">
                  {t("agents.instance.name")}
                </label>
                <Input
                  id="instance-wizard-label"
                  value={label}
                  autoFocus
                  maxLength={120}
                  placeholder={t("agents.instance.namePlaceholder")}
                  onChange={(event) => setLabel(event.target.value)}
                />
                <p className="agent-muted">{t("agents.instance.idHint")}</p>
              </div>
            </div>
          ) : null}

          {step === "config" && picked ? (
            <div className="wizard-pane">
              <p className="agent-muted">{t("agents.instance.copyHint")}</p>
              <div
                className="wizard-sources"
                role="radiogroup"
                aria-label={t("agents.instance.copyFrom")}
              >
                {sources.map((instance) => (
                  <ListRow
                    key={instance.instanceId}
                    render={<button type="button" role="radio" />}
                    aria-checked={source === instance.instanceId}
                    className="wizard-source"
                    title={instanceLabel(picked, instance)}
                    titleProps={{ className: "truncate" }}
                    description={<span className="mono truncate">{instance.instanceId}</span>}
                    meta={
                      source === instance.instanceId ? (
                        <Check className="ic ic-sm" aria-hidden="true" />
                      ) : null
                    }
                    onClick={() => setSource(instance.instanceId)}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </Dialog.Body>
        <Dialog.Footer>
          {step === "agent" ? (
            <Dialog.Close render={<Button type="button" variant="ghost" />}>
              {t("agents.instance.cancel")}
            </Dialog.Close>
          ) : (
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => setStep(STEPS[STEPS.indexOf(step) - 1] ?? "agent")}
            >
              {t("agents.instance.back")}
            </Button>
          )}
          {step === "config" ? (
            <Button
              type="button"
              variant="primary"
              disabled={saving || !canAdvance("identity")}
              onClick={create}
            >
              {t("agents.instance.create")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              disabled={saving || !canAdvance(step)}
              onClick={() => setStep(STEPS[STEPS.indexOf(step) + 1] ?? step)}
            >
              {t("agents.instance.next")}
            </Button>
          )}
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  )
}
