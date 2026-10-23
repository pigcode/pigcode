// 单个 agent 展开后的编辑区：检测详情、运行设置、环境变量、自定义模型、能力与操作。
import { useEffect, useMemo, useState } from "react"
import { ExternalLink } from "lucide-react"
import {
  CUSTOM_MODELS_KEY,
  localizeText,
  type AgentSummary,
  type ProviderSettingField,
  type ProviderSettingsValues,
  type ProviderStatus,
} from "@pigcode/contracts"
import { Badge, Button, useLocale } from "@pigcode/ui-primitives"
import {
  CustomModelsEditor,
  EnvironmentEditor,
  FieldControl,
  finalEnvironment,
  readEnvironment,
  type PickPath,
} from "./agent-fields"
import { capabilityKeys } from "./capabilities"

/** 编辑区需要的回调；保存失败时抛错，由编辑区展示原因。 */
export interface AgentEditorProps {
  agent: AgentSummary
  status: ProviderStatus | undefined
  onSave: (values: ProviderSettingsValues) => Promise<void>
  onUninstall?: (() => Promise<void>) | undefined
  onPickPath?: PickPath | undefined
  /** 打开外部链接（官网）；没有时不显示链接。 */
  onOpenExternal?: ((url: string) => void) | undefined
}

/**
 * 保存前整理：去掉没填名字的环境变量行，其余原样交给 Host 规范化。
 * 有不合法的变量名时返回 null，编辑区提示后不提交。
 */
function cleanValues(
  agent: AgentSummary,
  values: ProviderSettingsValues,
): ProviderSettingsValues | null {
  const next: ProviderSettingsValues = { ...values }
  for (const field of agent.fields) {
    if (field.type !== "env" || values[field.key] === undefined) continue
    const entries = finalEnvironment(values[field.key])
    if (!entries) return null
    next[field.key] = entries
  }
  return next
}

/** 两份设置是否相同；对象键顺序不影响结果。 */
function sameValues(left: ProviderSettingsValues, right: ProviderSettingsValues): boolean {
  const normalize = (values: ProviderSettingsValues) =>
    JSON.stringify(
      Object.keys(values)
        .sort()
        .map((key) => [key, values[key]]),
    )
  return normalize(left) === normalize(right)
}

function customModelsOf(values: ProviderSettingsValues): string[] {
  const models = values[CUSTOM_MODELS_KEY]
  return Array.isArray(models)
    ? models.filter((item): item is string => typeof item === "string")
    : []
}

/** 渲染编辑区；保存成功后以 Host 返回的值为准。 */
export function AgentEditor({
  agent,
  status,
  onSave,
  onUninstall,
  onPickPath,
  onOpenExternal,
}: AgentEditorProps) {
  const { locale, t } = useLocale()
  const [draft, setDraft] = useState<ProviderSettingsValues>(agent.values)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null)
  const [confirmUninstall, setConfirmUninstall] = useState(false)

  // Host 推来新的值（保存成功、别处修改）时重置草稿。
  useEffect(() => setDraft(agent.values), [agent.values])

  const dirty = useMemo(() => !sameValues(draft, agent.values), [draft, agent.values])
  const runtimeFields = agent.fields.filter(
    (field): field is Exclude<ProviderSettingField, { type: "env" }> => field.type !== "env",
  )
  const envFields = agent.fields.filter((field) => field.type === "env")
  const set = (key: string, value: unknown) => {
    setNotice(null)
    setDraft((current) => ({ ...current, [key]: value }))
  }

  async function save(): Promise<void> {
    const values = cleanValues(agent, draft)
    if (!values) {
      setNotice({ kind: "error", text: t("agents.env.invalid") })
      return
    }
    setSaving(true)
    setNotice(null)
    try {
      await onSave(values)
      setNotice({ kind: "ok", text: t("agents.saved") })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      setNotice({ kind: "error", text: t("agents.failed").replace("{reason}", reason) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="agent-editor">
      {agent.description || agent.homepage ? (
        <p className="agent-description">
          {agent.description ? localizeText(agent.description, locale) : null}
          {agent.homepage && onOpenExternal ? (
            <button
              type="button"
              className="agent-link"
              onClick={() => onOpenExternal(agent.homepage ?? "")}
            >
              {t("agents.homepage")}
              <ExternalLink className="ic ic-sm" aria-hidden="true" />
            </button>
          ) : null}
        </p>
      ) : null}

      <dl className="agent-facts">
        {status?.command ? (
          <>
            <dt>{t("agents.command")}</dt>
            <dd className="mono">{status.command}</dd>
          </>
        ) : null}
        {status?.installed && status.version ? (
          <>
            <dt>{t("agents.version")}</dt>
            <dd>{status.version}</dd>
          </>
        ) : null}
        {status?.account ? (
          <>
            <dt>{t("agents.account")}</dt>
            <dd>{status.account}</dd>
          </>
        ) : null}
        {status && !status.installed && agent.installHint ? (
          <>
            <dt>{t("agents.installHint")}</dt>
            <dd>{localizeText(agent.installHint, locale)}</dd>
          </>
        ) : null}
        {status?.error || (!agent.registered && agent.error) ? (
          <>
            <dt>{t("agents.error")}</dt>
            <dd className="error-text">{status?.error ?? agent.error}</dd>
          </>
        ) : null}
      </dl>

      {runtimeFields.length > 0 ? (
        <section className="agent-section" aria-label={t("agents.section.runtime")}>
          <h3>{t("agents.section.runtime")}</h3>
          {runtimeFields.map((field) => (
            <div className="agent-field" key={field.key}>
              <div className="agent-field-label">
                <span>{localizeText(field.label, locale)}</span>
                {field.description ? (
                  <span className="agent-muted">{localizeText(field.description, locale)}</span>
                ) : null}
              </div>
              <FieldControl
                field={field}
                value={draft[field.key]}
                onChange={(value) => set(field.key, value)}
                onPickPath={onPickPath}
              />
            </div>
          ))}
        </section>
      ) : null}

      {envFields.map((field) => {
        const label = localizeText(field.label, locale)
        return (
          <section className="agent-section" key={field.key} aria-label={label}>
            <h3>{label}</h3>
            {field.description ? (
              <p className="agent-muted">{localizeText(field.description, locale)}</p>
            ) : null}
            <EnvironmentEditor
              label={label}
              entries={readEnvironment(draft[field.key])}
              onChange={(entries) => set(field.key, entries)}
            />
          </section>
        )
      })}

      {agent.customModels ? (
        <section className="agent-section" aria-label={t("agents.section.models")}>
          <h3>{t("agents.section.models")}</h3>
          <CustomModelsEditor
            models={customModelsOf(draft)}
            onChange={(models) => set(CUSTOM_MODELS_KEY, models)}
          />
        </section>
      ) : null}

      {agent.capabilities ? (
        <section className="agent-section" aria-label={t("agents.capabilities")}>
          <h3>{t("agents.capabilities")}</h3>
          <div className="cap-list">
            {capabilityKeys.map((capability) => (
              <Badge
                key={capability.key}
                variant={agent.capabilities?.[capability.key] ? "ok" : "neutral"}
              >
                {t(capability.labelKey)}
              </Badge>
            ))}
          </div>
        </section>
      ) : null}

      <footer className="agent-actions">
        {onUninstall ? (
          confirmUninstall ? (
            <Button
              size="sm"
              variant="danger"
              type="button"
              onClick={() => void onUninstall().finally(() => setConfirmUninstall(false))}
            >
              {t("agents.uninstallConfirm")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => setConfirmUninstall(true)}
            >
              {t("agents.uninstall")}
            </Button>
          )
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          type="button"
          disabled={Object.keys(draft).length === 0}
          onClick={() => {
            setNotice(null)
            setDraft({})
          }}
        >
          {t("agents.reset")}
        </Button>
        <span className="spacer" />
        {notice ? (
          <span
            className={notice.kind === "ok" ? "agent-notice" : "agent-notice error-text"}
            role="status"
          >
            {notice.text}
          </span>
        ) : dirty ? (
          <span className="agent-notice">{t("agents.unsaved")}</span>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          type="button"
          disabled={!dirty || saving}
          onClick={() => {
            setNotice(null)
            setDraft(agent.values)
          }}
        >
          {t("agents.revert")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          type="button"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {saving ? t("agents.saving") : t("agents.save")}
        </Button>
      </footer>
    </div>
  )
}
