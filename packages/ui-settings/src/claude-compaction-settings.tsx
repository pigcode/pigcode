import { useState } from "react"
import type { AgentSettingField, AgentSettingsValues, ClaudeIdlePolicy } from "@pigcode/contracts"
import { SettingRow, useLocale } from "@pigcode/ui-primitives"
import { ChoiceSelect } from "./choice-select"
import { AgentFields } from "./agent-fields"

export interface ClaudeDefaults {
  value: ClaudeIdlePolicy
  set(mode: ClaudeIdlePolicy): Promise<void>
}

/**
 * Claude 的自动压缩，几行放在 .agent-rows 里：这个 Claude 空闲的会话怎么压缩；所有 Claude 共用的默认
 * （选好就保存，不进草稿）；聊天中到多少 token 自动压缩。
 */
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }
  return (
    <>
      <SettingRow
        title={t("agents.claude.instancePolicy")}
        description={t(
          effective === "off"
            ? "agents.claude.offHint"
            : effective === "beforeCacheExpires"
              ? "agents.claude.cacheHint"
              : "agents.claude.returnHint",
        )}
      >
        <ChoiceSelect
          variant="field"
          className="agent-control"
          label={t("agents.claude.instancePolicy")}
          value={selected}
          options={[{ value: "default", label: inherited }, ...policies]}
          onChange={(mode) => onChange("idleCompaction", mode)}
        />
      </SettingRow>
      {onChangeDefault ? (
        <SettingRow
          title={t("agents.claude.idleDefault")}
          description={
            error ? (
              <span className="error-text" role="alert">
                {error}
              </span>
            ) : (
              t("agents.claude.defaultHint")
            )
          }
        >
          <ChoiceSelect
            variant="field"
            className="agent-control"
            label={t("agents.claude.idleDefault")}
            value={shared}
            options={policies}
            disabled={saving}
            onChange={(mode) => void changeDefault(mode)}
          />
        </SettingRow>
      ) : null}
      {threshold ? <AgentFields fields={[threshold]} values={values} onChange={onChange} /> : null}
    </>
  )
}
