/**
 * 实例的详情面板：右侧一列卡片，从上到下是实例本身（名字、启用、默认、删除）、运行设置、
 * 环境变量、自定义模型、Agent 功能与检测详情。一份实例一次编辑一个，保存按钮在底部。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { Check, ExternalLink, Trash2 } from "lucide-react"
import {
  CUSTOM_MODELS_KEY,
  localizeText,
  type AgentInstance,
  type AgentSummary,
  type AgentSettingField,
  type AgentSettingsValues,
  type AgentStatus,
} from "@pigcode/contracts"
import {
  Badge,
  Button,
  EntityAvatar,
  Input,
  StatusDot,
  Switch,
  hostErrorMessageKey,
  toHostError,
  useLocale,
} from "@pigcode/ui-primitives"
import {
  CustomModelsEditor,
  EnvironmentEditor,
  FieldControl,
  finalEnvironment,
  readEnvironment,
  type PickPath,
} from "./agent-fields"
import { agentFeatureKeys } from "./agent-features"
import { instanceLabel } from "./agent-instances"
import { instanceHeadline } from "./agent-status"

/** 详情面板需要的回调；保存失败时抛错，由面板展示原因。 */
export interface AgentEditorProps {
  agent: AgentSummary
  /** 正在编辑的实例。 */
  instance: AgentInstance
  /** 这个实例的检测结果。 */
  status: AgentStatus | undefined
  /** 新会话默认使用的实例 id。 */
  defaultInstanceId: string | null
  onSave: (values: AgentSettingsValues) => Promise<void>
  onUpdateInstance: (
    instanceId: string,
    patch: { label?: string; enabled?: boolean },
  ) => Promise<void>
  onRemoveInstance: (instanceId: string) => Promise<void>
  onSetDefaultInstance: (instanceId: string) => Promise<void>
  onUninstall?: (() => Promise<void>) | undefined
  onPickPath?: PickPath | undefined
  /** 打开外部链接（官网）；没有时不显示链接。 */
  onOpenExternal?: ((url: string) => void) | undefined
}

/**
 * 保存前整理：去掉没填名字的环境变量行，其余原样交给 Host 规范化。
 * 有不合法的变量名时返回 null，面板提示后不提交。
 */
function cleanValues(agent: AgentSummary, values: AgentSettingsValues): AgentSettingsValues | null {
  const next: AgentSettingsValues = { ...values }
  for (const field of agent.fields) {
    if (field.type !== "env" || values[field.key] === undefined) continue
    const entries = finalEnvironment(values[field.key])
    if (!entries) return null
    next[field.key] = entries
  }
  return next
}

/** 两份设置是否相同；对象键顺序不影响结果。 */
function sameValues(left: AgentSettingsValues, right: AgentSettingsValues): boolean {
  const normalize = (values: AgentSettingsValues) =>
    JSON.stringify(
      Object.keys(values)
        .sort()
        .map((key) => [key, values[key]]),
    )
  return normalize(left) === normalize(right)
}

function customModelsOf(values: AgentSettingsValues): string[] {
  const models = values[CUSTOM_MODELS_KEY]
  return Array.isArray(models)
    ? models.filter((item): item is string => typeof item === "string")
    : []
}

/** 一张分节卡片：标题、可选的说明与右侧的头部操作，下面是内容。 */
function Section({
  title,
  description,
  action,
  children,
}: {
  title: string
  description?: string | undefined
  action?: ReactNode | undefined
  children: ReactNode
}) {
  return (
    <section className="agent-card" aria-label={title}>
      <header className="agent-card-head">
        <div className="agent-card-heading">
          <h2>{title}</h2>
          {description ? <p className="agent-muted">{description}</p> : null}
        </div>
        {action ? <div className="agent-card-action">{action}</div> : null}
      </header>
      <div className="agent-card-body">{children}</div>
    </section>
  )
}

/** 渲染实例的详情面板；保存成功后以 Host 返回的值为准。 */
export function AgentEditor({
  agent,
  instance,
  status,
  defaultInstanceId,
  onSave,
  onUpdateInstance,
  onRemoveInstance,
  onSetDefaultInstance,
  onUninstall,
  onPickPath,
  onOpenExternal,
}: AgentEditorProps) {
  const { locale, t } = useLocale()
  const [draft, setDraft] = useState<AgentSettingsValues>(instance.values)
  const [label, setLabel] = useState(instance.label)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null)
  const [confirmUninstall, setConfirmUninstall] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  // Host 推来新的值（保存成功、别处修改、切换实例）时重置草稿。
  useEffect(() => {
    setDraft(instance.values)
    setLabel(instance.label)
    setNotice(null)
    setConfirmRemove(false)
    setConfirmUninstall(false)
  }, [instance.instanceId, instance.label, instance.values])

  const dirty = useMemo(() => !sameValues(draft, instance.values), [draft, instance.values])
  const renamed = label.trim().length > 0 && label.trim() !== instance.label
  const runtimeFields = agent.fields.filter(
    (field): field is Exclude<AgentSettingField, { type: "env" }> => field.type !== "env",
  )
  const envFields = agent.fields.filter((field) => field.type === "env")
  const headline = instanceHeadline(agent, instance, status)
  const isDefault = instance.isDefault
  const isDefaultForSessions = defaultInstanceId === instance.instanceId

  const set = (key: string, value: unknown) => {
    setNotice(null)
    setDraft((current) => ({ ...current, [key]: value }))
  }

  /** 统一处理实例操作：期间禁用按钮，失败时把原因写进提示。 */
  async function run(action: () => Promise<void>): Promise<void> {
    setSaving(true)
    setNotice(null)
    try {
      await action()
    } catch (error) {
      setNotice({ kind: "error", text: failureText(error) })
    } finally {
      setSaving(false)
    }
  }

  async function save(): Promise<void> {
    const values = cleanValues(agent, draft)
    if (!values) {
      setNotice({ kind: "error", text: t("agents.env.invalid") })
      return
    }
    await run(async () => {
      await onSave(values)
      setNotice({ kind: "ok", text: t("agents.saved") })
    })
  }

  /**
   * 失败提示：有专门说明的错误码（例如实例还在被会话使用）显示当前语言的解释，
   * 其余按「操作失败：<Host 的原始信息>」显示。
   */
  function failureText(error: unknown): string {
    const info = toHostError(error)
    const key = hostErrorMessageKey(info.code)
    return key ? t(key) : t("agents.failed").replace("{reason}", info.message)
  }

  return (
    <div className="agent-editor">
      <header className="agent-editor-head">
        <EntityAvatar id={instance.instanceId} name={instanceLabel(agent, instance)} />
        <div className="agent-editor-title">
          <h1 className="truncate">{instanceLabel(agent, instance)}</h1>
          <p className="agent-editor-meta">
            <code className="mono truncate">{instance.instanceId}</code>
            <span className="agent-editor-status" data-tone={headline.tone}>
              <StatusDot tone={headline.tone} />
              {t(headline.label)}
            </span>
            {instance.isDefault ? <Badge>{t("agents.instance.default")}</Badge> : null}
            {instance.enabled ? null : <Badge>{t("agents.instance.disabled")}</Badge>}
          </p>
        </div>
        {agent.homepage && onOpenExternal ? (
          <Button
            size="sm"
            variant="ghost"
            type="button"
            onClick={() => onOpenExternal(agent.homepage ?? "")}
          >
            {t("agents.homepage")}
            <ExternalLink className="ic ic-sm" aria-hidden="true" />
          </Button>
        ) : null}
      </header>

      {agent.description ? (
        <p className="agent-description">{localizeText(agent.description, locale)}</p>
      ) : null}

      <Section
        title={t("agents.instance.section.identity")}
        action={
          <Switch
            aria-label={t("agents.instance.enable")}
            checked={instance.enabled}
            disabled={saving}
            onCheckedChange={(enabled) =>
              void run(() => onUpdateInstance(instance.instanceId, { enabled }))
            }
          />
        }
      >
        {isDefault ? (
          <p className="agent-muted">{t("agents.instance.isDefaultHint")}</p>
        ) : (
          <div className="agent-identity">
            <div className="field">
              <label className="label" htmlFor="agent-instance-label">
                {t("agents.instance.name")}
              </label>
              <div className="agent-input-row">
                <Input
                  id="agent-instance-label"
                  className="agent-input"
                  value={label}
                  maxLength={120}
                  disabled={saving}
                  onChange={(event) => setLabel(event.target.value)}
                />
                <Button
                  size="sm"
                  type="button"
                  disabled={saving || !renamed}
                  onClick={() =>
                    void run(async () => {
                      await onUpdateInstance(instance.instanceId, { label: label.trim() })
                      setNotice({ kind: "ok", text: t("agents.saved") })
                    })
                  }
                >
                  {t("agents.instance.rename")}
                </Button>
              </div>
            </div>
            <div className="agent-identity-actions">
              <Button
                size="sm"
                type="button"
                disabled={saving || isDefaultForSessions}
                onClick={() => void run(() => onSetDefaultInstance(instance.instanceId))}
              >
                <Check className="ic ic-sm" aria-hidden="true" />
                {isDefaultForSessions
                  ? t("agents.instance.isSessionDefault")
                  : t("agents.instance.setDefault")}
              </Button>
              {confirmRemove ? (
                <>
                  <Button
                    size="sm"
                    variant="danger"
                    type="button"
                    disabled={saving}
                    onClick={() => void run(() => onRemoveInstance(instance.instanceId))}
                  >
                    {t("agents.instance.removeConfirm")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    type="button"
                    onClick={() => setConfirmRemove(false)}
                  >
                    {t("agents.instance.cancel")}
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  disabled={saving}
                  onClick={() => setConfirmRemove(true)}
                >
                  <Trash2 className="ic ic-sm" aria-hidden="true" />
                  {t("agents.instance.remove")}
                </Button>
              )}
            </div>
            {confirmRemove ? (
              <p className="agent-muted">{t("agents.instance.removeHint")}</p>
            ) : null}
          </div>
        )}
      </Section>

      {runtimeFields.length > 0 ? (
        <Section title={t("agents.section.runtime")}>
          <div className="agent-fields">
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
          </div>
        </Section>
      ) : null}

      {envFields.map((field) => {
        const fieldLabel = localizeText(field.label, locale)
        return (
          <Section
            key={field.key}
            title={fieldLabel}
            {...(field.description ? { description: localizeText(field.description, locale) } : {})}
          >
            <EnvironmentEditor
              label={fieldLabel}
              entries={readEnvironment(draft[field.key])}
              onChange={(entries) => set(field.key, entries)}
            />
          </Section>
        )
      })}

      {agent.customModels ? (
        <Section title={t("agents.section.models")}>
          <CustomModelsEditor
            models={customModelsOf(draft)}
            onChange={(models) => set(CUSTOM_MODELS_KEY, models)}
          />
        </Section>
      ) : null}

      {status || agent.features ? (
        <Section title={t("agents.section.diagnostics")}>
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
          {agent.features ? (
            <div className="agent-feature-list">
              {agentFeatureKeys.map((feature) => (
                <Badge key={feature.key} variant={agent.features?.[feature.key] ? "ok" : "neutral"}>
                  {t(feature.labelKey)}
                </Badge>
              ))}
            </div>
          ) : null}
        </Section>
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
            setDraft(instance.values)
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
