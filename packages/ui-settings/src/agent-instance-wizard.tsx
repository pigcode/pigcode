import { useEffect, useRef, useState } from "react"
import { Check, ChevronDown } from "lucide-react"
import {
  acpRegistryAgentIdSchema,
  customAgentInstanceIdSchema,
  type AcpRegistryEntry,
  type AgentAuthState,
  type AgentInstanceDraft,
  type AgentSettingsValues,
  type AgentSummary,
} from "@pigcode/contracts"
import { Button, Dialog, hostErrorMessageKey, toHostError, useLocale } from "@pigcode/ui-primitives"
import { AgentFields, cleanAgentValues, type PickPath } from "./agent-fields"
import { AcpRegistryPicker, RegistryIcon, type RegistryActions } from "./acp-registry-picker"
import { AcpAccount, acpAuthPending } from "./acp-account"
import { AgentChoices, InstanceIdentity } from "./agent-instance-choice"
import { instanceIdTaken, suggestInstanceId } from "./agent-instances"
import type { AgentSetupActions } from "./agent-setup"

type Source = "plugin" | "registry" | "manual" | "local"
type Choice = { agentId: string; source: Source; entry?: AcpRegistryEntry }
type Step = "agent" | "identity" | "config" | "signIn"
const stepLabels = {
  agent: "agents.instance.step.agent",
  identity: "agents.instance.step.identity",
  config: "agents.instance.step.config",
  signIn: "agents.acp.account",
} as const

interface Draft {
  label: string
  idOverride: string | null
  values: AgentSettingsValues
}
const empty: Draft = { label: "", idOverride: null, values: {} }
const draftKey = (choice: Choice) =>
  [choice.agentId, choice.source, choice.source === "registry" ? choice.entry?.id : ""].join("/")
const isFeatured = (agent: AgentSummary) => agent.featured ?? agent.builtin

export interface InstanceCreateWizardProps {
  onClose: (createdId?: string) => void
  agents: readonly AgentSummary[]
  agentId?: string | null
  onPickPath?: PickPath | undefined
  registry?: RegistryActions | undefined
  setupActions?: AgentSetupActions | undefined
  openExternal?: ((url: string) => void | Promise<void>) | undefined
  onCreateInstance: (draft: AgentInstanceDraft) => Promise<string>
}

export function InstanceCreateWizard({
  onClose,
  agents,
  agentId,
  onPickPath,
  registry,
  setupActions,
  openExternal,
  onCreateInstance,
}: InstanceCreateWizardProps) {
  const { t } = useLocale()
  const available = agents.filter((agent) => agent.enabled && agent.registered)
  const dedicated = available.filter((agent) => !agent.acpRegistry)
  const featured = dedicated.filter(isFeatured)
  const more = dedicated.filter((agent) => !isFeatured(agent))
  const acp = available.find((agent) => agent.acpRegistry)
  const initial = dedicated.find((agent) => agent.agentId === agentId) ?? featured[0]
  const [choice, setChoice] = useState<Choice | null>(() =>
    initial ? { agentId: initial.agentId, source: "plugin" } : null,
  )
  const [expanded, setExpanded] = useState(
    () => !featured.length || agentId === acp?.agentId || Boolean(initial && !isFeatured(initial)),
  )
  const [step, setStep] = useState<Step>("agent")
  const [drafts, setDrafts] = useState(() => new Map<string, Draft>())
  const [created, setCreated] = useState<string>()
  const [authPhase, setAuthPhase] = useState<AgentAuthState["phase"]>()
  const [preparing, setPreparing] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rejected, setRejected] = useState<string>()
  const busy = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const agent = available.find((item) => item.agentId === choice?.agentId)
  const source = choice?.source
  const registryChoice = source === "registry" || source === "manual"
  const form = source === "manual" || source === "local"
  const key = choice ? draftKey(choice) : ""
  const draft = drafts.get(key) ?? empty
  const used = new Set(agents.flatMap((a) => [a.agentId, ...a.instances.map((i) => i.instanceId)]))
  const added = new Set(
    acp?.instances.flatMap(({ values }) =>
      typeof values.registryId === "string" ? [values.registryId] : [],
    ),
  )
  const label = draft.label.trim()
  const instanceId =
    draft.idOverride ?? (agent ? suggestInstanceId(agent.agentId, label, used) : "")
  const taken = instanceId === rejected || instanceIdTaken(instanceId, used)
  const idError = taken
    ? t("hostError.AGENT_INSTANCE_ID_TAKEN")
    : customAgentInstanceIdSchema.safeParse(instanceId).success
      ? null
      : t("agents.instance.idHint")
  const command = typeof draft.values.binaryPath === "string" ? draft.values.binaryPath.trim() : ""
  const registryId =
    typeof draft.values.registryId === "string" ? draft.values.registryId.trim() : ""
  const fields = (agent?.fields ?? []).filter((field) => {
    if (source === "local") return field.key !== "registryId" && field.key !== "authMethodId"
    if (source === "manual") return true
    return field.type !== "env" && field.key !== "registryId"
  })
  const steps: Step[] =
    source === "local"
      ? ["agent", "identity"]
      : ["agent", "identity", registryChoice ? "signIn" : "config"]
  const index = steps.indexOf(step)
  const locked = saving || acpAuthPending(authPhase)

  function update(patch: Partial<Draft>) {
    setDrafts((all) => new Map(all).set(key, { ...(all.get(key) ?? empty), ...patch }))
    setRejected(undefined)
    setError(null)
  }
  function pick(next: Choice) {
    setChoice(next)
    setError(null)
    setFailure(null)
    setRejected(undefined)
  }
  function go(next: Step) {
    setStep(next)
    setError(null)
  }
  async function prepare(id: string, manual = false) {
    if (!registry || !acp || busy.current) return
    busy.current = true
    setPreparing(id)
    setError(null)
    setFailure(null)
    try {
      const entry = await registry.prepare(id)
      if (!mounted.current) return
      const next: Choice = { agentId: acp.agentId, source: manual ? "manual" : "registry", entry }
      const nextKey = draftKey(next)
      setDrafts((all) => {
        const previous = all.get(nextKey) ?? empty
        return new Map(all).set(nextKey, {
          ...previous,
          label: previous.label || entry.name,
          values: { ...previous.values, registryId: entry.id },
        })
      })
      pick(next)
      go("identity")
    } catch (cause) {
      if (mounted.current) {
        const message = cause instanceof Error ? cause.message : String(cause)
        if (manual) setError(message)
        else setFailure({ id, message })
      }
    } finally {
      busy.current = false
      if (mounted.current) setPreparing(null)
    }
  }
  function fromSource() {
    if (!choice || !agent || busy.current) return
    if (!cleanAgentValues(fields, draft.values)) {
      setError(t("agents.env.invalid"))
      return
    }
    if (source === "manual" && !command) {
      void prepare(registryId, true)
      return
    }
    if (source === "manual") {
      pick({ agentId: agent.agentId, source })
      if (!label) update({ label: registryId })
    }
    go("identity")
  }
  async function save() {
    if (!agent || !choice || busy.current || created) return
    if (!label || idError) {
      go("identity")
      return
    }
    const values = cleanAgentValues(fields, draft.values)
    if (!values) {
      setError(t("agents.env.invalid"))
      return
    }
    if (registryChoice) values.registryId = registryId
    busy.current = true
    setSaving(true)
    setError(null)
    try {
      const id = await onCreateInstance({
        agentId: agent.agentId,
        instanceId,
        label,
        values,
        ...(registryChoice && choice.entry && !command
          ? { preparedVersion: choice.entry.version }
          : {}),
      })
      if (!mounted.current) return
      if (registryChoice && setupActions) {
        setCreated(id)
        go("signIn")
      } else onClose(id)
    } catch (cause) {
      if (!mounted.current) return
      const failure = toHostError(cause)
      if (failure.code === "AGENT_INSTANCE_ID_TAKEN") {
        setRejected(instanceId)
        go("identity")
      } else {
        const key = hostErrorMessageKey(failure.code)
        setError(key ? t(key) : t("agents.failed").replace("{reason}", failure.message))
      }
    } finally {
      busy.current = false
      if (mounted.current) setSaving(false)
    }
  }
  const editFields = (
    <AgentFields
      fields={fields}
      values={draft.values}
      onPickPath={onPickPath}
      onChange={(name, value) => update({ values: { ...draft.values, [name]: value } })}
    />
  )
  const nextDisabled =
    !agent ||
    preparing !== null ||
    (source === "local" && !command) ||
    (source === "manual" && !acpRegistryAgentIdSchema.safeParse(registryId).success)
  const finish = step === "config" || (step === "identity" && source !== "plugin")

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !locked) onClose(created)
      }}
    >
      <Dialog.Content
        className="instance-wizard"
        title={t("agents.instance.addTitle")}
        closeLabel={t("common.close")}
        closeDisabled={locked}
      >
        <Dialog.Body>
          <ol className="wizard-steps" aria-label={t("agents.instance.steps")}>
            {steps.map((item, i) => (
              <li key={item} className="wizard-step" data-current={i === index || undefined}>
                <button
                  type="button"
                  className="wizard-step-btn"
                  aria-current={i === index ? "step" : undefined}
                  disabled={Boolean(created) || saving || preparing !== null || i > index}
                  onClick={() => go(item)}
                >
                  <span className="wizard-step-mark" data-done={i < index || undefined}>
                    {i < index ? <Check className="ic ic-sm" aria-hidden="true" /> : i + 1}
                  </span>
                  {t(stepLabels[item])}
                </button>
              </li>
            ))}
          </ol>
          {step === "agent" && (
            <div className="wizard-pane wizard-sources">
              {available.length === 0 && (
                <p className="agent-muted">{t("agents.instance.noAgents")}</p>
              )}
              <AgentChoices
                agents={featured}
                label={t("agents.list")}
                selectedId={choice?.agentId}
                disabled={preparing !== null}
                onSelect={(a) => pick({ agentId: a.agentId, source: "plugin" })}
              />
              {(acp || more.length > 0) && (
                <button
                  type="button"
                  className="wizard-disclosure"
                  disabled={preparing !== null}
                  aria-expanded={expanded}
                  onClick={() => {
                    if (expanded && agent && (!isFeatured(agent) || agent.acpRegistry)) {
                      const first = featured[0]
                      setChoice(first ? { agentId: first.agentId, source: "plugin" } : null)
                      setError(null)
                    }
                    setExpanded(!expanded)
                  }}
                >
                  {t(expanded ? "agents.instance.showLess" : "agents.instance.showMore")}
                  <ChevronDown className="ic ic-xs" aria-hidden="true" />
                </button>
              )}
              {expanded && (
                <>
                  <AgentChoices
                    agents={more}
                    label={t("agents.instance.showMore")}
                    selectedId={choice?.agentId}
                    disabled={preparing !== null}
                    onSelect={(a) => pick({ agentId: a.agentId, source: "plugin" })}
                  />
                  {acp &&
                    (form ? (
                      <section className="acp-registry">
                        <div className="acp-manual-heading">
                          <span>
                            {t(source === "manual" ? "agents.acp.manual" : "agents.acp.useLocal")}
                          </span>
                          {registry && (
                            <Button
                              size="sm"
                              type="button"
                              variant="ghost"
                              disabled={preparing !== null}
                              onClick={() => {
                                setChoice(null)
                                setError(null)
                              }}
                            >
                              {t("agents.acp.backToList")}
                            </Button>
                          )}
                        </div>
                        <fieldset className="wizard-config" disabled={preparing !== null}>
                          {editFields}
                        </fieldset>
                      </section>
                    ) : registry ? (
                      <AcpRegistryPicker
                        load={registry.list}
                        added={added}
                        preparing={preparing}
                        failure={failure}
                        openExternal={openExternal}
                        onAdd={(e) => void prepare(e.id)}
                        onManual={() => pick({ agentId: acp.agentId, source: "manual" })}
                        onLocal={() => pick({ agentId: acp.agentId, source: "local" })}
                      />
                    ) : (
                      <Button
                        size="sm"
                        type="button"
                        onClick={() => pick({ agentId: acp.agentId, source: "local" })}
                      >
                        {t("agents.acp.useLocal")}
                      </Button>
                    ))}
                </>
              )}
            </div>
          )}
          {step === "identity" && agent && (
            <InstanceIdentity
              agent={agent}
              entry={choice?.entry}
              label={draft.label}
              instanceId={instanceId}
              idError={idError}
              onLabel={(name) => update({ label: name })}
              onId={(id) => update({ idOverride: id })}
              openExternal={openExternal}
            />
          )}
          {step === "config" && (
            <fieldset className="wizard-pane wizard-config" disabled={saving}>
              {fields.length ? (
                editFields
              ) : (
                <p className="agent-muted">{t("agents.instance.noConfig")}</p>
              )}
            </fieldset>
          )}
          {step === "signIn" && created && setupActions && (
            <div className="wizard-pane acp-sign-in">
              <div className="acp-identity">
                {choice?.entry ? (
                  <RegistryIcon entry={choice.entry} />
                ) : (
                  <span className="acp-registry-icon">
                    <Check className="ic" aria-hidden="true" />
                  </span>
                )}
                <div className="acp-registry-copy">
                  <span className="acp-registry-name">{label}</span>
                  <span className="acp-registry-description mono">{created}</span>
                </div>
                {openExternal && (choice?.entry?.website || choice?.entry?.repository) && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void openExternal(choice?.entry?.website || choice?.entry?.repository || "")
                    }
                  >
                    {t("agents.homepage")}
                  </Button>
                )}
              </div>
              <AcpAccount
                key={created}
                actions={setupActions}
                instanceId={created}
                onPhase={setAuthPhase}
                methodId={
                  typeof draft.values.authMethodId === "string"
                    ? draft.values.authMethodId
                    : undefined
                }
              />
            </div>
          )}
        </Dialog.Body>
        <Dialog.Footer className="wizard-footer">
          {error && (
            <p className="error-text wizard-error" role="alert">
              {error}
            </p>
          )}
          {created ? (
            <Button
              size="lg"
              type="button"
              variant={authPhase === "connected" ? "primary" : "secondary"}
              disabled={locked}
              onClick={() => onClose(created)}
            >
              {t(authPhase === "connected" ? "agents.acp.done" : "agents.acp.skip")}
            </Button>
          ) : (
            <>
              <Button
                size="lg"
                type="button"
                variant="ghost"
                disabled={saving}
                onClick={() => (step === "agent" ? onClose() : go(steps[index - 1] ?? "agent"))}
              >
                {t(step === "agent" ? "agents.instance.cancel" : "agents.instance.back")}
              </Button>
              <Button
                size="lg"
                type="button"
                variant="primary"
                disabled={
                  saving || nextDisabled || (step === "identity" && (!label || idError !== null))
                }
                onClick={() => {
                  if (finish) void save()
                  else if (step === "agent") fromSource()
                  else go("config")
                }}
              >
                {t(
                  saving
                    ? "agents.saving"
                    : preparing && source === "manual"
                      ? "agents.acp.preparing"
                      : finish
                        ? registryChoice
                          ? "agents.acp.continueSignIn"
                          : "agents.instance.create"
                        : "agents.instance.next",
                )}
              </Button>
            </>
          )}
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  )
}
