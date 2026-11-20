import { useState } from "react"
import type { AgentSettingField, AgentSettingsValues, ClaudeIdlePolicy } from "@pigcode/contracts"
import { Button, useLocale } from "@pigcode/ui-primitives"
import { ChoiceSelect } from "./choice-select"
import { AgentFields } from "./agent-fields"

export interface ClaudeDefaults {
  value: ClaudeIdlePolicy
  set(mode: ClaudeIdlePolicy): Promise<void>
}

export function ClaudeCompactionSettings({
  defaultPolicy = "onReturn",
  onChangeDefault,
  threshold,
  values,
  onChange,
}: {
  defaultPolicy?: ClaudeIdlePolicy | undefined
  onChangeDefault?: ClaudeDefaults["set"] | undefined
  threshold?: AgentSettingField | undefined
  values: AgentSettingsValues
  onChange: (key: string, value: unknown) => void
}) {
  const { t } = useLocale()
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const policies = [
    { value: "onReturn", label: t("agents.claude.onReturn") },
    { value: "beforeCacheExpires", label: t("agents.claude.beforeExpires") },
    { value: "off", label: t("agents.claude.never") },
  ] as const
  const shared = defaultPolicy
  const selected =
    policies.find((option) => option.value === values.idleCompaction)?.value ?? "default"
  const effective = selected === "default" ? shared : selected
  const inherited = t("agents.claude.inherit").replace(
    "{policy}",
    policies.find((option) => option.value === shared)!.label,
  )
  async function changeDefault(mode: ClaudeIdlePolicy) {
    if (!onChangeDefault || saving) return
    setSaving(true)
    setError("")
    try {
      await onChangeDefault(mode)
      setEditing(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="claude-context">
      <div className="claude-policy">
        <div className="claude-policy-heading">
          <span className="label">{t("agents.claude.instancePolicy")}</span>
          <ChoiceSelect
            variant="field"
            label={t("agents.claude.instancePolicy")}
            value={selected}
            options={[{ value: "default", label: inherited }, ...policies]}
            onChange={(mode) => onChange("idleCompaction", mode)}
          />
        </div>
        <p className="agent-muted">
          {t(
            effective === "off"
              ? "agents.claude.offHint"
              : effective === "beforeCacheExpires"
                ? "agents.claude.cacheHint"
                : "agents.claude.returnHint",
          )}
        </p>
        {onChangeDefault && (
          <div className="claude-default-control">
            <Button
              size="sm"
              variant="ghost"
              type="button"
              aria-expanded={editing}
              disabled={saving}
              onClick={() => {
                setEditing(!editing)
                setError("")
              }}
            >
              {t("agents.claude.editDefault")}
            </Button>
            {editing && (
              <div className="claude-default-editor">
                <span className="label">{t("agents.claude.idleDefault")}</span>
                <ChoiceSelect
                  variant="field"
                  label={t("agents.claude.idleDefault")}
                  value={shared}
                  options={policies}
                  disabled={saving}
                  onChange={(mode) => void changeDefault(mode)}
                />
                <p className="agent-muted">{t("agents.claude.defaultHint")}</p>
              </div>
            )}
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
      </div>
      {threshold && <AgentFields fields={[threshold]} values={values} onChange={onChange} />}
    </div>
  )
}
