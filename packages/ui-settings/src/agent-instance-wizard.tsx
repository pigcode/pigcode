import { useEffect, useRef, useState } from "react"
import { ChevronDown } from "lucide-react"
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
import { AcpRegistryPicker, ManualAcpSource, type RegistryActions } from "./acp-registry-picker"
import { AcpAccount, acpAuthPending } from "./acp-account"
import {
  AgentChoices,
  InstanceIdentity,
  SignInIdentity,
  WizardFooter,
  WizardSteps,
  type WizardStep as Step,
} from "./agent-instance-choice"
import { instanceIdTaken, suggestInstanceId } from "./agent-instances"
import type { AgentSetupActions } from "./agent-setup"

type Source = "managed" | "plugin" | "registry" | "manual" | "local"
type Choice = { agentId: string; source: Source; entry?: AcpRegistryEntry }

interface Draft {
  accentColor?: string | undefined
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
  const featured = dedicated
    .filter(isFeatured)
    .sort((a, b) => Number(b.agentId === "codex") - Number(a.agentId === "codex"))
  const more = dedicated.filter((agent) => !isFeatured(agent))
  const acp = available.find((agent) => agent.acpRegistry)
  const initial = dedicated.find((agent) => agent.agentId === agentId) ?? featured[0]
  const [selection, setChoice] = useState<Choice | null>()
  const choice: Choice | null =
    selection === undefined
      ? initial
        ? { agentId: initial.agentId, source: "plugin" }
        : null
      : selection
  const [expansion, setExpanded] = useState<boolean>()
  const expanded =
    expansion ??
    (!featured.length ||
      Boolean(acp && agentId === acp.agentId) ||
      Boolean(initial && !isFeatured(initial)))
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
  const used = new Set(
    agents.flatMap((a) => [
      ...(a.agentId === agent?.agentId && a.requiresInstance ? [] : [a.agentId]),
      ...a.instances.map((i) => i.instanceId),
    ]),
  )
  const added = new Set(
    acp?.instances.flatMap(({ values }) =>
      typeof values.registryId === "string" ? [values.registryId] : [],
    ),
  )
  const managedAccount = source === "managed"
  const signInAfterCreate = registryChoice || managedAccount
  const manualName =
    typeof draft.values.registryId === "string" ? draft.values.registryId.trim() : ""
  const label = managedAccount
    ? "ChatGPT - " + (draft.label.trim() || t("agents.codex.personal"))
    : draft.label.trim() ||
      choice?.entry?.name ||
      (source === "manual" ? manualName : agent?.displayName) ||
      ""
  const instanceId =
    draft.idOverride ??
    (agent ? suggestInstanceId(agent.agentId, label === agent.displayName ? "" : label, used) : "")
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
    if (field.visibility) return false
    if (source === "local") return field.key !== "registryId" && field.key !== "authMethodId"
    if (source === "manual") return true
    return field.type !== "env" && field.key !== "registryId"
  })
  const steps: Step[] =
    source === "local"
      ? ["agent", "identity"]
      : ["agent", "identity", signInAfterCreate ? "signIn" : "config"]
  const index = steps.indexOf(step)
  const locked = saving || acpAuthPending(authPhase)

  function update(patch: Partial<Draft>) {
    setDrafts((all) => new Map(all).set(key, { ...(all.get(key) ?? empty), ...patch }))
    setRejected(undefined)
    setError(null)
  }
  function updateManagedName(next: Choice) {
    const key = draftKey(next)
    setDrafts((all) =>
      all.has(key)
        ? all
        : new Map(all).set(key, {
            ...empty,
            label: t("agents.codex.personal"),
            idOverride: "codex_" + crypto.randomUUID(),
          }),
    )
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
      setError(t("agents.settings.invalid"))
      return
    }
    if (source === "manual" && !command) {
      void prepare(registryId, true)
      return
    }
    if (source === "manual") {
      pick({ agentId: agent.agentId, source })
      if (!draft.label.trim()) update({ label: registryId })
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
      setError(t("agents.settings.invalid"))
      return
    }
    if (agent.agentId === "codex" && agent.fields.some((f) => f.key === "setupMode"))
      values.setupMode = managedAccount ? "managed" : "existing"
    if (registryChoice) values.registryId = registryId
    busy.current = true
    setSaving(true)
    setError(null)
    try {
      const id = await onCreateInstance({
        agentId: agent.agentId,
        instanceId,
        ...(draft.accentColor ? { accentColor: draft.accentColor } : {}),
        label,
        values,
        ...(registryChoice && choice.entry && !command
          ? { preparedVersion: choice.entry.version }
          : {}),
      })
      if (!mounted.current) return
      if (signInAfterCreate && setupActions) {
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
      references={agent?.secretReferences}
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
          <WizardSteps
            steps={steps}
            index={index}
            locked={Boolean(created) || saving || preparing !== null}
            onStep={go}
          />
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
                      <ManualAcpSource
                        local={source === "local"}
                        busy={preparing !== null}
                        onBack={
                          registry
                            ? () => {
                                setChoice(null)
                                setError(null)
                              }
                            : undefined
                        }
                        onSource={(kind) => pick({ agentId: acp.agentId, source: kind })}
                      >
                        {editFields}
                      </ManualAcpSource>
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
          {step === "identity" && managedAccount && (
            <div className="wizard-pane">
              <label className="field">
                {t("agents.codex.accountName")}
                <input
                  className="input"
                  autoFocus
                  maxLength={100}
                  value={draft.label}
                  placeholder={t("agents.codex.personal")}
                  onChange={(e) => update({ label: e.target.value })}
                />
              </label>
            </div>
          )}
          {step === "identity" && agent && !managedAccount && (
            <InstanceIdentity
              agent={agent}
              entry={choice?.entry}
              label={draft.label}
              instanceId={instanceId}
              idError={idError}
              color={draft.accentColor}
              onColor={(accentColor) => update({ accentColor })}
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
              <SignInIdentity
                label={label}
                instanceId={created}
                entry={choice?.entry}
                openExternal={openExternal}
              />
              <AcpAccount
                key={created}
                agentId={agent?.agentId}
                actions={setupActions}
                openExternal={openExternal}
                autoStartMethod={managedAccount ? "chatgpt" : undefined}
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
        <WizardFooter
          created={Boolean(created)}
          connected={authPhase === "connected"}
          locked={locked}
          saving={saving}
          error={error}
          first={step === "agent"}
          disabled={saving || nextDisabled || (step === "identity" && idError !== null)}
          nextLabel={t(
            saving
              ? "agents.saving"
              : preparing && source === "manual"
                ? "agents.acp.preparing"
                : finish
                  ? signInAfterCreate
                    ? "agents.acp.continueSignIn"
                    : "agents.instance.create"
                  : "agents.instance.next",
          )}
          onBack={() =>
            step === "agent" || created ? onClose(created) : go(steps[index - 1] ?? "agent")
          }
          onNext={() => {
            if (finish) void save()
            else if (step === "agent") fromSource()
            else go("config")
          }}
          onManaged={
            step === "agent" && agent?.agentId === "codex" && setupActions && !preparing
              ? () => {
                  const next: Choice = { agentId: "codex", source: "managed" }
                  pick(next)
                  updateManagedName(next)
                  go("identity")
                }
              : undefined
          }
        />
      </Dialog.Content>
    </Dialog.Root>
  )
}
