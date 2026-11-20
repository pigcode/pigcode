import { Check } from "lucide-react"
import {
  AGENT_INSTANCE_ID_MAX_LENGTH,
  type AcpRegistryEntry,
  type AgentSummary,
} from "@pigcode/contracts"
import { AgentIcon, Button, Input, SegmentedControl, useLocale } from "@pigcode/ui-primitives"
import { AccentField } from "./instance-accent"
import { RegistryIcon } from "./agent-directory"

export function CodexConnection({
  agent,
  managed,
  busy,
  label,
  onLabel,
  onMode,
}: {
  agent: AgentSummary
  managed: boolean
  busy: boolean
  label: string
  onLabel(value: string): void
  onMode(mode: "managed" | "plugin"): void
}) {
  const { t } = useLocale()
  return (
    <>
      <SegmentedControl
        aria-label={t("agents.directory.connection")}
        value={managed ? "managed" : "plugin"}
        disabled={busy}
        onValueChange={onMode}
        options={[
          { value: "managed", label: t("agents.codex.signIn") },
          { value: "plugin", label: t("agents.codex.manual") },
        ]}
      />
      {managed && (
        <div className="instance-identity">
          <div className="wizard-picked">
            <AgentIcon agentId={agent.agentId} name={agent.displayName} />
            <span>{agent.displayName}</span>
          </div>
          <label className="field">
            {t("agents.codex.accountName")}
            <Input
              size="xl"
              autoFocus
              maxLength={100}
              value={label}
              placeholder={t("agents.codex.personal")}
              onChange={(e) => onLabel(e.target.value)}
            />
          </label>
        </div>
      )}
    </>
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
    <div className="instance-identity">
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
