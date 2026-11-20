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
  type ClaudeIdlePolicy,
} from "@pigcode/contracts"
import {
  Dialog,
  SegmentedControl,
  hostErrorMessageKey,
  toHostError,
  useLocale,
} from "@pigcode/ui-primitives"
import { AgentFields, cleanAgentValues, type PickPath } from "./agent-fields"
import { ClaudeCompactionSettings } from "./claude-compaction-settings"
import { AgentDirectory, type RegistryActions } from "./agent-directory"
import { AcpAccount, acpAuthPending } from "./acp-account"
import {
  CodexConnection,
  InstanceIdentity,
  SignInIdentity,
  WizardFooter,
  WizardSteps,
} from "./agent-instance-identity"
import { instanceIdTaken, suggestInstanceId } from "./agent-instances"
import type { AgentSetupActions } from "./agent-setup"

type Step = "agent" | "source" | "configure" | "signIn"
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
  claudeDefault?: ClaudeIdlePolicy | undefined
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
  claudeDefault,
  onPickPath,
  registry,
  setupActions,
  openExternal,
  onCreateInstance,
}: InstanceCreateWizardProps) {
  const { t } = useLocale()
  const available = agents.filter((agent) => agent.enabled && agent.registered)
  const dedicated = available.filter((agent) => !agent.acpRegistry)
  const drivers = dedicated.sort(
    (a, b) =>
      Number(isFeatured(b)) - Number(isFeatured(a)) ||
      Number(b.agentId === "codex") - Number(a.agentId === "codex"),
  )
  const acp = available.find((agent) => agent.acpRegistry)
  const [query, setQuery] = useState("")
  const [choice, setChoice] = useState<Choice | null>(null)
  const [step, setStep] = useState<Step>("agent")
  const [drafts, setDrafts] = useState(() => new Map<string, Draft>())
  const [created, setCreated] = useState<string>()
  const [authPhase, setAuthPhase] = useState<AgentAuthState["phase"]>()
  const [preparing, setPreparing] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rejected, setRejected] = useState<string>()
  const [advanced, setAdvanced] = useState(false)
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
      go("configure")
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
    go("configure")
  }
  async function save() {
    if (!agent || !choice || busy.current || created) return
    if (!label || idError) {
      go("configure")
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
        go("configure")
      } else {
        const key = hostErrorMessageKey(failure.code)
        setError(key ? t(key) : t("agents.failed").replace("{reason}", failure.message))
      }
    } finally {
      busy.current = false
      if (mounted.current) setSaving(false)
    }
  }
  const hasCompaction =
    agent?.agentId === "claude" && fields.some((field) => field.key === "idleCompaction")
  const startupFields = hasCompaction
    ? fields.filter((field) => field.key !== "idleCompaction" && field.key !== "autoCompactWindow")
    : fields
  const editField = (name: string, value: unknown) =>
    update({ values: { ...draft.values, [name]: value } })
  const editFields = (
    <AgentFields
      references={agent?.secretReferences}
      fields={startupFields}
      values={draft.values}
      onPickPath={onPickPath}
      onChange={editField}
    />
  )
  const invalidSource =
    source === "local" ? !command : !acpRegistryAgentIdSchema.safeParse(registryId).success
  const configureCodex = agent?.agentId === "codex" && Boolean(setupActions)
  function openDriver(item: AgentSummary) {
    const next: Choice = {
      agentId: item.agentId,
      source: item.agentId === "codex" && setupActions ? "managed" : "plugin",
    }
    if (next.source === "managed") updateManagedName(next)
    pick(next)
    go("configure")
  }
  function openManual(kind: "local" | "manual") {
    if (!acp) return
    pick({ agentId: acp.agentId, source: kind })
    go("source")
  }
  const fromManual = source === "manual" || source === "local"
  function back() {
    if (step === "configure" && fromManual) go("source")
    else {
      go("agent")
      setFailure(null)
    }
  }

  const steps: { id: Step; label: string }[] = [
    { id: "agent", label: t("agents.instance.step.agent") },
    ...(fromManual ? [{ id: "source" as const, label: t("agents.instance.step.source") }] : []),
    { id: "configure", label: t("agents.instance.step.config") },
    ...(signInAfterCreate && setupActions
      ? [{ id: "signIn" as const, label: t("agents.instance.step.signIn") }]
      : []),
  ]
  const currentStepIndex = steps.findIndex((item) => item.id === step)

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !locked) onClose(created)
      }}
    >
      <Dialog.Content
        className="instance-wizard"
        data-view={step}
        title={t("agents.instance.addTitle")}
        closeLabel={t("common.close")}
        closeDisabled={locked}
      >
        <WizardSteps steps={steps} currentIndex={currentStepIndex} />

        <Dialog.Body>
          {step === "agent" && (
            <AgentDirectory
              agents={drivers}
              preferredId={agentId}
              registry={acp ? registry : undefined}
              local={Boolean(acp)}
              added={added}
              query={query}
              onQuery={setQuery}
              preparing={preparing}
              failure={failure}
              onAgent={openDriver}
              onAdd={(id) => void prepare(id)}
              openExternal={openExternal}
              onLocal={() => openManual("local")}
              onManual={() => openManual("manual")}
            />
          )}
          {step === "source" && (
            <div className="wizard-pane">
              {registry ? (
                <SegmentedControl
                  aria-label={t("agents.acp.source")}
                  value={source === "local" ? "local" : "manual"}
                  disabled={Boolean(preparing)}
                  onValueChange={openManual}
                  options={[
                    { value: "local", label: t("agents.acp.useLocal") },
                    { value: "manual", label: t("agents.directory.byId") },
                  ]}
                />
              ) : (
                <h3 className="label">{t("agents.acp.useLocal")}</h3>
              )}
              <fieldset className="wizard-config" disabled={Boolean(preparing)}>
                <div className="agent-rows">{editFields}</div>
              </fieldset>
            </div>
          )}
          {step === "configure" && agent && (
            <div className="wizard-pane">
              {configureCodex && (
                <CodexConnection
                  agent={agent}
                  managed={managedAccount}
                  busy={saving}
                  label={draft.label}
                  onLabel={(label) => update({ label })}
                  onMode={(source) => {
                    const next = { agentId: agent.agentId, source }
                    if (source === "managed") updateManagedName(next)
                    pick(next)
                  }}
                />
              )}
              {!managedAccount && (
                <InstanceIdentity
                  agent={agent}
                  entry={choice?.entry}
                  label={draft.label}
                  instanceId={instanceId}
                  idError={idError}
                  color={draft.accentColor}
                  onColor={(accentColor) => update({ accentColor })}
                  onLabel={(label) => update({ label })}
                  onId={(idOverride) => update({ idOverride })}
                  openExternal={openExternal}
                />
              )}
              {(source === "plugin" && startupFields.length > 0) || hasCompaction ? (
                <div className="wizard-advanced" data-open={advanced || undefined}>
                  <button
                    type="button"
                    className="wizard-advanced-toggle"
                    aria-expanded={advanced}
                    onClick={() => setAdvanced(!advanced)}
                  >
                    <span>{t("agents.advanced")}</span>
                    <ChevronDown className="ic ic-sm wizard-advanced-caret" aria-hidden="true" />
                  </button>
                  {advanced ? (
                    <div className="wizard-advanced-body">
                      {source === "plugin" && startupFields.length > 0 ? (
                        <fieldset className="wizard-config" disabled={saving}>
                          <legend>{t("agents.section.runtime")}</legend>
                          <div className="agent-rows">{editFields}</div>
                        </fieldset>
                      ) : null}
                      {hasCompaction ? (
                        <fieldset className="wizard-config" disabled={saving}>
                          <legend>{t("agents.claude.context")}</legend>
                          <div className="agent-rows">
                            <ClaudeCompactionSettings
                              defaultPolicy={claudeDefault}
                              values={draft.values}
                              threshold={fields.find((field) => field.key === "autoCompactWindow")}
                              onChange={editField}
                            />
                          </div>
                        </fieldset>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
          {step === "signIn" && created && setupActions && (
            <div className="wizard-pane acp-sign-in">
              <SignInIdentity
                label={label}
                instanceId={created}
                entry={choice?.entry}
                openExternal={openExternal}
              />
              <div className="wizard-signin-card">
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
            </div>
          )}
        </Dialog.Body>
        {step !== "agent" && (
          <WizardFooter
            error={error}
            created={created}
            authPhase={authPhase}
            locked={locked}
            saving={saving}
            preparing={preparing !== null}
            step={step}
            fromManual={fromManual}
            invalidSource={invalidSource}
            idError={idError}
            signInAfterCreate={Boolean(signInAfterCreate && setupActions)}
            onClose={() => onClose(created)}
            onBack={back}
            onSubmit={() => {
              if (step === "source") fromSource()
              else void save()
            }}
          />
        )}
      </Dialog.Content>
    </Dialog.Root>
  )
}
