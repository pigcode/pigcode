/**
 * 新建实例的向导：选择 Agent → 名称与 ID → 启动配置。三步都在一个对话框里，
 * 步骤条可以点回已经填过的步骤。
 */
import { useEffect, useMemo, useState } from "react"
import { Check } from "lucide-react"
import {
  AGENT_INSTANCE_ID_MAX_LENGTH,
  customAgentInstanceIdSchema,
  type AcpRegistryEntry,
  type AgentInstanceDraft,
  type AgentSettingsValues,
  type AgentSummary,
} from "@pigcode/contracts"
import {
  AgentIcon,
  Button,
  Dialog,
  Input,
  SearchField,
  hostErrorMessageKey,
  toHostError,
  useLocale,
} from "@pigcode/ui-primitives"
import { AgentFields, cleanAgentValues, type PickPath } from "./agent-fields"
import { AcpRegistryPicker } from "./acp-registry-picker"
import { instanceIdTaken, instancesOf, suggestInstanceId } from "./agent-instances"

/** 向导的三步；数组顺序就是步骤条的显示顺序。 */
const STEPS = ["agent", "identity", "config"] as const
type Step = (typeof STEPS)[number]

/** 每一步在步骤条上的名字。 */
const STEP_LABEL = {
  agent: "agents.instance.step.agent",
  identity: "agents.instance.step.identity",
  config: "agents.instance.step.config",
} as const

interface WizardDraft {
  label: string
  idOverride: string | null
  values: AgentSettingsValues
}

const EMPTY_DRAFT: WizardDraft = { label: "", idOverride: null, values: {} }

export interface InstanceCreateWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 可选的 Agent；停用或没注册的不会列出来。 */
  agents: readonly AgentSummary[]
  /** 打开时预选的 Agent，通常是设置页里正在看的那个。 */
  agentId?: string | null
  onPickPath?: PickPath | undefined
  loadAcpRegistry?: (() => Promise<AcpRegistryEntry[]>) | undefined
  onCreateInstance: (draft: AgentInstanceDraft) => Promise<void>
}

/** 渲染新建实例的向导。 */
export function InstanceCreateWizard({
  open,
  onOpenChange,
  agents,
  agentId = null,
  onPickPath,
  loadAcpRegistry,
  onCreateInstance,
}: InstanceCreateWizardProps) {
  const { t } = useLocale()
  const [step, setStep] = useState<Step>("agent")
  const [query, setQuery] = useState("")
  const [pickedId, setPickedId] = useState<string | null>(null)
  const [registryMode, setRegistryMode] = useState(false)
  const [drafts, setDrafts] = useState(() => new Map<string, WizardDraft>())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rejectedId, setRejectedId] = useState<string | null>(null)

  // 每次打开都从第一步开始，沿用设置页里正在看的 Agent。
  useEffect(() => {
    if (!open) return
    setStep("agent")
    setQuery("")
    setPickedId(agentId)
    setRegistryMode(false)
    setDrafts(new Map())
    setError(null)
    setRejectedId(null)
  }, [open, agentId])

  const selectable = useMemo(
    () => agents.filter((agent) => agent.enabled && agent.registered),
    [agents],
  )
  const picked = selectable.find((agent) => agent.agentId === pickedId) ?? null
  const acp = selectable.find((agent) => agent.acpRegistry)
  const runtimeFields =
    picked?.fields.filter((field) =>
      picked.acpRegistry ? field.key !== "registryId" : field.type !== "env",
    ) ?? []
  const usedIds = useMemo(
    () =>
      new Set(
        agents.flatMap((agent) => [
          agent.agentId,
          ...agent.instances.map((item) => item.instanceId),
        ]),
      ),
    [agents],
  )
  const matches = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return selectable
    return selectable.filter((agent) =>
      (agent.acpRegistry ? t("agents.acp.local") : agent.displayName)
        .toLowerCase()
        .includes(keyword),
    )
  }, [selectable, query, t])
  const draftKey = picked ? picked.agentId + (registryMode ? "/registry" : "") : null
  const draft = draftKey ? (drafts.get(draftKey) ?? EMPTY_DRAFT) : EMPTY_DRAFT
  const registrySelection = registryMode && typeof draft.values.registryId === "string"
  const missingCommand =
    picked?.acpRegistry &&
    !registrySelection &&
    (typeof draft.values.binaryPath !== "string" || !draft.values.binaryPath.trim())
  const label = draft.label.trim()
  const instanceId =
    draft.idOverride ?? (picked ? suggestInstanceId(picked.agentId, label, usedIds) : "")
  const idTaken = instanceId === rejectedId || instanceIdTaken(instanceId, usedIds)
  const idValid = customAgentInstanceIdSchema.safeParse(instanceId).success
  const idError = idTaken
    ? t("hostError.AGENT_INSTANCE_ID_TAKEN")
    : !idValid
      ? t("agents.instance.idHint")
      : null

  function updateDraft(update: (current: WizardDraft) => WizardDraft): void {
    if (!draftKey) return
    setDrafts((current) =>
      new Map(current).set(draftKey, update(current.get(draftKey) ?? EMPTY_DRAFT)),
    )
    setError(null)
  }

  function goTo(next: Step): void {
    setStep(next)
    setError(null)
  }

  async function create(): Promise<void> {
    if (!picked || saving) return
    if (!label || idError) {
      goTo("identity")
      return
    }
    const configured = Object.fromEntries(
      runtimeFields
        .filter(({ key }) => Object.hasOwn(draft.values, key))
        .map(({ key }) => [key, draft.values[key]]),
    )
    if (registrySelection) configured.registryId = draft.values.registryId
    const values = cleanAgentValues(runtimeFields, configured)
    if (!values) {
      setError(t("agents.env.invalid"))
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onCreateInstance({ agentId: picked.agentId, instanceId, label, values })
      onOpenChange(false)
    } catch (reason) {
      const failure = toHostError(reason)
      if (failure.code === "AGENT_INSTANCE_ID_TAKEN") {
        setRejectedId(instanceId)
        updateDraft((current) => ({ ...current, idOverride: instanceId }))
        goTo("identity")
      } else {
        const key = hostErrorMessageKey(failure.code)
        setError(key ? t(key) : t("agents.failed").replace("{reason}", failure.message))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next)
      }}
    >
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
                    onClick={() => goTo(item)}
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
                size="lg"
                value={query}
                onValueChange={setQuery}
                placeholder={t("agents.instance.search")}
              />
              {matches.length === 0 && !acp ? (
                <p className="agent-muted">
                  {t(
                    selectable.length === 0
                      ? "agents.instance.noAgents"
                      : "agents.instance.noMatches",
                  )}
                </p>
              ) : (
                <div className="wizard-agents" role="listbox" aria-label={t("agents.list")}>
                  {matches.map((agent) => {
                    const selected = agent.agentId === pickedId && !registryMode
                    return (
                      <button
                        key={agent.agentId}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className="wizard-agent"
                        onClick={() => {
                          setRegistryMode(false)
                          setPickedId(agent.agentId)
                        }}
                      >
                        <AgentIcon agentId={agent.agentId} name={agent.displayName} size="lg" />
                        <span className="wizard-agent-text">
                          <span className="truncate">
                            {agent.acpRegistry ? t("agents.acp.local") : agent.displayName}
                          </span>
                          {agent.acpRegistry ? null : (
                            <span className="agent-muted truncate">
                              {agent.version ??
                                t("agents.instance.count").replace(
                                  "{count}",
                                  String(instancesOf(agent).length),
                                )}
                            </span>
                          )}
                        </span>
                        {selected ? <Check className="ic ic-sm" aria-hidden="true" /> : null}
                      </button>
                    )
                  })}
                  {acp && loadAcpRegistry ? (
                    <button
                      type="button"
                      role="option"
                      aria-selected={registryMode}
                      className="wizard-agent"
                      onClick={() => {
                        setPickedId(acp.agentId)
                        setRegistryMode(true)
                      }}
                    >
                      <AgentIcon agentId={acp.agentId} name={acp.displayName} size="lg" />
                      <span>{t("agents.acp.registry")}</span>
                      {registryMode ? <Check className="ic ic-sm" aria-hidden="true" /> : null}
                    </button>
                  ) : null}
                </div>
              )}
              {registryMode && loadAcpRegistry ? (
                <AcpRegistryPicker
                  load={loadAcpRegistry}
                  selected={draft.values.registryId}
                  onSelect={(entry) =>
                    updateDraft(() => ({
                      label: entry.name,
                      idOverride: null,
                      values: { registryId: entry.id },
                    }))
                  }
                />
              ) : null}
            </div>
          ) : null}

          {step === "identity" && picked ? (
            <div className="wizard-pane">
              <div className="wizard-picked">
                <AgentIcon agentId={picked.agentId} name={picked.displayName} />
                <span>{picked.displayName}</span>
              </div>
              <div className="field">
                <label className="label" htmlFor="instance-wizard-label">
                  {t("agents.instance.name")}
                </label>
                <Input
                  size="xl"
                  id="instance-wizard-label"
                  value={draft.label}
                  autoFocus
                  maxLength={120}
                  placeholder={t("agents.instance.namePlaceholder")}
                  onChange={(event) => {
                    const name = event.target.value
                    updateDraft((current) => ({ ...current, label: name }))
                  }}
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="instance-wizard-id">
                  {t("agents.instance.idLabel")}
                </label>
                <Input
                  size="xl"
                  id="instance-wizard-id"
                  className="mono"
                  value={instanceId}
                  maxLength={AGENT_INSTANCE_ID_MAX_LENGTH}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={idError !== null}
                  aria-describedby="instance-wizard-id-hint"
                  onChange={(event) => {
                    const id = event.target.value
                    updateDraft((current) => ({ ...current, idOverride: id }))
                  }}
                />
                <p id="instance-wizard-id-hint" className={idError ? "error-text" : "hint"}>
                  {idError ?? t("agents.instance.idHint")}
                </p>
              </div>
            </div>
          ) : null}

          {step === "config" && picked ? (
            <fieldset className="wizard-pane wizard-config" disabled={saving}>
              {runtimeFields.length > 0 ? (
                <AgentFields
                  fields={runtimeFields}
                  values={draft.values}
                  onChange={(key, value) =>
                    updateDraft((current) => ({
                      ...current,
                      values: { ...current.values, [key]: value },
                    }))
                  }
                  onPickPath={onPickPath}
                />
              ) : (
                <p className="agent-muted">{t("agents.instance.noConfig")}</p>
              )}
            </fieldset>
          ) : null}
        </Dialog.Body>
        <Dialog.Footer className="wizard-footer">
          {error ? (
            <p className="error-text wizard-error" role="alert">
              {error}
            </p>
          ) : null}
          {step === "agent" ? (
            <Dialog.Close render={<Button size="lg" type="button" variant="ghost" />}>
              {t("agents.instance.cancel")}
            </Dialog.Close>
          ) : (
            <Button
              size="lg"
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => goTo(STEPS[STEPS.indexOf(step) - 1] ?? "agent")}
            >
              {t("agents.instance.back")}
            </Button>
          )}
          {step === "config" ? (
            <Button
              size="lg"
              type="button"
              variant="primary"
              disabled={saving || !picked || missingCommand}
              onClick={() => void create()}
            >
              {t(saving ? "agents.saving" : "agents.instance.create")}
            </Button>
          ) : (
            <Button
              size="lg"
              type="button"
              variant="primary"
              disabled={
                saving ||
                !picked ||
                (registryMode && !registrySelection) ||
                (step === "identity" && (!label || idError !== null))
              }
              onClick={() => goTo(STEPS[STEPS.indexOf(step) + 1] ?? step)}
            >
              {t("agents.instance.next")}
            </Button>
          )}
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  )
}
