import { Check } from "lucide-react"
import {
  AGENT_INSTANCE_ID_MAX_LENGTH,
  type AcpRegistryEntry,
  type AgentSummary,
} from "@pigcode/contracts"
import { AgentIcon, Button, Dialog, Input, useLocale } from "@pigcode/ui-primitives"
import { AccentField } from "./instance-accent"
import { RegistryIcon } from "./acp-registry-picker"

export function AgentChoices({
  agents,
  label,
  selectedId,
  disabled,
  onSelect,
}: {
  agents: readonly AgentSummary[]
  label: string
  selectedId?: string | undefined
  disabled: boolean
  onSelect: (agent: AgentSummary) => void
}) {
  if (!agents.length) return null
  return (
    <div className="wizard-agents" role="listbox" aria-label={label}>
      {agents.map((agent) => (
        <button
          key={agent.agentId}
          type="button"
          role="option"
          disabled={disabled}
          aria-selected={selectedId === agent.agentId}
          className="wizard-agent"
          onClick={() => onSelect(agent)}
        >
          <AgentIcon agentId={agent.agentId} name={agent.displayName} size="lg" />
          <span className="truncate">{agent.displayName}</span>
          {selectedId === agent.agentId && <Check className="ic ic-sm" aria-hidden="true" />}
        </button>
      ))}
    </div>
  )
}

export function InstanceIdentity({
  agent,
  entry,
  label,
  instanceId,
  idError,
  color,
  onColor,
  onLabel,
  onId,
  openExternal,
}: {
  agent: AgentSummary
  entry?: AcpRegistryEntry | undefined
  label: string
  instanceId: string
  idError: string | null
  color?: string | undefined
  onColor: (value: string | undefined) => void
  onLabel: (value: string) => void
  onId: (value: string) => void
  openExternal?: ((url: string) => void | Promise<void>) | undefined
}) {
  const { t } = useLocale()
  return (
    <div className="wizard-pane">
      {entry ? (
        <div className="acp-identity">
          <RegistryIcon entry={entry} />
          <div className="acp-registry-copy">
            <span className="acp-registry-name">{entry.name}</span>
            <span className="acp-registry-description">
              {[entry.version, entry.distribution, entry.license].filter(Boolean).join(" · ")}
            </span>
          </div>
          <RegistryLinks entry={entry} openExternal={openExternal} />
        </div>
      ) : (
        <div className="wizard-picked">
          <AgentIcon agentId={agent.agentId} name={agent.displayName} />
          <span>{agent.displayName}</span>
        </div>
      )}
      <div className="field">
        <label className="label" htmlFor="instance-wizard-label">
          {t("agents.instance.name")}
        </label>
        <Input
          size="xl"
          id="instance-wizard-label"
          value={label}
          autoFocus
          maxLength={120}
          placeholder={agent.displayName}
          onChange={(event) => onLabel(event.target.value)}
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
          onChange={(event) => onId(event.target.value)}
        />
        <p id="instance-wizard-id-hint" className={idError ? "error-text" : "hint"}>
          {idError ?? t("agents.instance.idHint")}
        </p>
      </div>
      <AccentField color={color} onChange={onColor} />
    </div>
  )
}

export function WizardFooter({
  created,
  connected,
  locked,
  saving,
  error,
  first,
  disabled,
  nextLabel,
  onBack,
  onNext,
  onManaged,
}: {
  created: boolean
  connected: boolean
  locked: boolean
  saving: boolean
  error: string | null
  first: boolean
  disabled: boolean
  nextLabel: string
  onBack: () => void
  onNext: () => void
  onManaged?: (() => void) | undefined
}) {
  const { t } = useLocale()
  return (
    <Dialog.Footer className="wizard-footer">
      {error && (
        <p className="error-text wizard-error" role="alert">
          {error}
        </p>
      )}
      {created ? (
        <Button
          size="lg"
          variant={connected ? "primary" : "secondary"}
          disabled={locked}
          onClick={onBack}
        >
          {t(connected ? "agents.acp.done" : "agents.acp.skip")}
        </Button>
      ) : (
        <>
          <Button type="button" size="lg" variant="ghost" disabled={saving} onClick={onBack}>
            {t(first ? "agents.instance.cancel" : "agents.instance.back")}
          </Button>
          {onManaged ? (
            <>
              <Button
                type="button"
                size="lg"
                variant="secondary"
                disabled={disabled}
                onClick={onNext}
              >
                {t("agents.codex.manual")}
              </Button>
              <Button
                type="button"
                size="lg"
                variant="primary"
                disabled={disabled}
                onClick={onManaged}
              >
                {t("agents.codex.signIn")}
              </Button>
            </>
          ) : (
            <Button type="button" size="lg" variant="primary" disabled={disabled} onClick={onNext}>
              {nextLabel}
            </Button>
          )}
        </>
      )}
    </Dialog.Footer>
  )
}

export function SignInIdentity({
  label,
  instanceId,
  entry,
  openExternal,
}: {
  label: string
  instanceId: string
  entry?: AcpRegistryEntry | undefined
  openExternal?: ((url: string) => void | Promise<void>) | undefined
}) {
  return (
    <div className="acp-identity">
      {entry ? (
        <RegistryIcon entry={entry} />
      ) : (
        <span className="acp-registry-icon">
          <Check className="ic" aria-hidden="true" />
        </span>
      )}
      <div className="acp-registry-copy">
        <span className="acp-registry-name">{label}</span>
        <span className="acp-registry-description mono">{instanceId}</span>
      </div>
      {entry && <RegistryLinks entry={entry} openExternal={openExternal} />}
    </div>
  )
}

export type WizardStep = "agent" | "identity" | "config" | "signIn"
const stepLabels = {
  agent: "agents.instance.step.agent",
  identity: "agents.instance.step.identity",
  config: "agents.instance.step.config",
  signIn: "agents.acp.account",
} as const

export function WizardSteps({
  steps,
  index,
  locked,
  onStep,
}: {
  steps: readonly WizardStep[]
  index: number
  locked: boolean
  onStep: (step: WizardStep) => void
}) {
  const { t } = useLocale()
  return (
    <ol className="wizard-steps" aria-label={t("agents.instance.steps")}>
      {steps.map((item, i) => (
        <li key={item} className="wizard-step" data-current={i === index || undefined}>
          <button
            type="button"
            className="wizard-step-btn"
            aria-current={i === index ? "step" : undefined}
            disabled={locked || i > index}
            onClick={() => onStep(item)}
          >
            <span className="wizard-step-mark" data-done={i < index || undefined}>
              {i < index ? <Check className="ic ic-sm" aria-hidden="true" /> : i + 1}
            </span>
            {t(stepLabels[item])}
          </button>
        </li>
      ))}
    </ol>
  )
}

function RegistryLinks({
  entry,
  openExternal,
}: {
  entry: AcpRegistryEntry
  openExternal?: ((url: string) => void | Promise<void>) | undefined
}) {
  const { t } = useLocale()
  if (!openExternal) return null
  return (
    <>
      {entry.website && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => void openExternal(entry.website!)}
        >
          {t("agents.acp.docs")}
        </Button>
      )}
      {entry.repository && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => void openExternal(entry.repository!)}
        >
          {t("agents.acp.sourceCode")}
        </Button>
      )}
    </>
  )
}
