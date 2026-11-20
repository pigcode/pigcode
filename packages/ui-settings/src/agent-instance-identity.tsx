import { ArrowLeft, Check, ExternalLink } from "lucide-react"
import {
  AGENT_INSTANCE_ID_MAX_LENGTH,
  type AcpRegistryEntry,
  type AgentAuthState,
  type AgentSummary,
} from "@pigcode/contracts"
import {
  AgentIcon,
  Button,
  Dialog,
  Input,
  SegmentedControl,
  SettingRow,
  useLocale,
} from "@pigcode/ui-primitives"
import { AccentPicker } from "./instance-accent"
import { RegistryIcon } from "./agent-directory"

export function WizardFooter({
  error,
  created,
  authPhase,
  locked,
  saving,
  preparing,
  step,
  fromManual,
  invalidSource,
  idError,
  signInAfterCreate,
  onClose,
  onBack,
  onSubmit,
}: {
  error: string | null
  created?: string | undefined
  authPhase?: AgentAuthState["phase"] | undefined
  locked: boolean
  saving: boolean
  preparing: boolean
  step: "source" | "configure" | "signIn"
  fromManual: boolean
  invalidSource: boolean
  idError: string | null
  signInAfterCreate: boolean
  onClose: () => void
  onBack: () => void
  onSubmit: () => void
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
          variant={authPhase === "connected" ? "primary" : "secondary"}
          disabled={locked}
          onClick={onClose}
        >
          {t(authPhase === "connected" ? "agents.acp.done" : "agents.acp.skip")}
        </Button>
      ) : (
        <>
          <Button size="lg" variant="ghost" disabled={saving || preparing} onClick={onBack}>
            <ArrowLeft className="ic ic-sm" aria-hidden="true" />
            {t(
              step === "configure" && fromManual ? "agents.instance.back" : "agents.acp.backToList",
            )}
          </Button>
          <Button
            size="lg"
            variant="primary"
            disabled={saving || preparing || (step === "source" ? invalidSource : Boolean(idError))}
            onClick={onSubmit}
          >
            {t(
              saving
                ? "agents.saving"
                : preparing
                  ? "agents.acp.preparing"
                  : step === "source"
                    ? "agents.instance.next"
                    : signInAfterCreate
                      ? "agents.acp.continueSignIn"
                      : "agents.instance.create",
            )}
          </Button>
        </>
      )}
    </Dialog.Footer>
  )
}

/** 步骤条：几步平分一排，每步一个序号圈加名字；走过的打勾，当前这一步浮起来。 */
export function WizardSteps({
  steps,
  currentIndex,
}: {
  steps: readonly { id: string; label: string }[]
  currentIndex: number
}) {
  const { t } = useLocale()
  return (
    <ol className="wizard-steps" aria-label={t("agents.instance.steps")}>
      {steps.map((item, index) => {
        const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "next"
        return (
          <li
            key={item.id}
            className="wizard-step"
            data-state={state}
            aria-current={state === "current" ? "step" : undefined}
          >
            <span className="wizard-step-mark" aria-hidden="true">
              {state === "done" ? <Check className="ic ic-xs" /> : index + 1}
            </span>
            <span className="truncate">{item.label}</span>
          </li>
        )
      })}
    </ol>
  )
}

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
    <div className="wizard-codex">
      <SegmentedControl
        className="wizard-codex-mode"
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
            <span className="wizard-picked-tile">
              <AgentIcon agentId={agent.agentId} name={agent.displayName} size="lg" />
            </span>
            <div className="wizard-picked-copy">
              <span className="wizard-picked-name">{agent.displayName}</span>
              <span className="wizard-picked-meta">{t("agents.codex.signIn")}</span>
            </div>
          </div>
          <div className="agent-rows">
            <SettingRow
              title={<label htmlFor="codex-account-name">{t("agents.codex.accountName")}</label>}
              description={t("agents.instance.nameHint")}
            >
              <Input
                id="codex-account-name"
                className="agent-control"
                autoFocus
                maxLength={100}
                value={label}
                placeholder={t("agents.codex.personal")}
                onChange={(e) => onLabel(e.target.value)}
              />
            </SettingRow>
          </div>
        </div>
      )}
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
    <div className="instance-identity">
      {entry ? (
        <div className="acp-identity wizard-picked">
          <span className="wizard-picked-tile">
            <RegistryIcon entry={entry} />
          </span>
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
          <span className="wizard-picked-tile">
            <AgentIcon
              agentId={agent.agentId}
              instanceId={instanceId || undefined}
              accentColor={color}
              name={label || agent.displayName}
              size="lg"
            />
          </span>
          <div className="wizard-picked-copy">
            <span className="wizard-picked-name">{agent.displayName}</span>
            <span className="wizard-picked-meta mono">{instanceId || agent.agentId}</span>
          </div>
        </div>
      )}
      <div className="agent-rows">
        <SettingRow
          title={<label htmlFor="instance-wizard-label">{t("agents.instance.name")}</label>}
          description={t("agents.instance.nameHint")}
        >
          <Input
            id="instance-wizard-label"
            className="agent-control"
            value={label}
            autoFocus
            maxLength={120}
            placeholder={agent.displayName}
            onChange={(event) => onLabel(event.target.value)}
          />
        </SettingRow>
        <SettingRow
          title={<label htmlFor="instance-wizard-id">{t("agents.instance.idLabel")}</label>}
          description={
            <span id="instance-wizard-id-hint" className={idError ? "error-text" : undefined}>
              {idError ?? t("agents.instance.idHint")}
            </span>
          }
        >
          <Input
            id="instance-wizard-id"
            className="agent-control mono"
            value={instanceId}
            maxLength={AGENT_INSTANCE_ID_MAX_LENGTH}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={idError !== null}
            aria-describedby="instance-wizard-id-hint"
            onChange={(event) => onId(event.target.value)}
          />
        </SettingRow>
        <SettingRow title={t("agents.instance.color")} description={t("agents.instance.colorHint")}>
          <AccentPicker color={color} onChange={onColor} />
        </SettingRow>
      </div>
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
    <div className="acp-identity wizard-picked">
      {entry ? (
        <span className="wizard-picked-tile">
          <RegistryIcon entry={entry} />
        </span>
      ) : (
        <span className="wizard-picked-tile is-ok">
          <Check className="ic ic-sm" aria-hidden="true" />
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
    <div className="wizard-registry-links">
      {entry.website && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => void openExternal(entry.website!)}
        >
          {t("agents.acp.docs")}
          <ExternalLink className="ic ic-xs" aria-hidden="true" />
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
          <ExternalLink className="ic ic-xs" aria-hidden="true" />
        </Button>
      )}
    </div>
  )
}
