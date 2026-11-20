import { Check } from "lucide-react"
import {
  AGENT_INSTANCE_ID_MAX_LENGTH,
  type AcpRegistryEntry,
  type AgentSummary,
} from "@pigcode/contracts"
import { AgentIcon, Button, Input, useLocale } from "@pigcode/ui-primitives"
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
  onLabel,
  onId,
  openExternal,
}: {
  agent: AgentSummary
  entry?: AcpRegistryEntry | undefined
  label: string
  instanceId: string
  idError: string | null
  onLabel: (value: string) => void
  onId: (value: string) => void
  openExternal?: ((url: string) => void | Promise<void>) | undefined
}) {
  const { t } = useLocale()
  const about = entry?.website || entry?.repository
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
          {about && openExternal && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void openExternal(about)}
            >
              {t("agents.homepage")}
            </Button>
          )}
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
          placeholder={t("agents.instance.namePlaceholder")}
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
    </div>
  )
}
