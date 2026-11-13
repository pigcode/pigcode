/**
 * 实例展开后的设置（参照 t3code 设置页里实例的展开区）：最上面是概览（介绍、账号、版本与可执行文件），
 * 下面按标签页分开：模型（显示、排序、自定义）、运行设置、环境变量，自建实例还有一页「实例」
 * （改名、删除）。保存条在最下面，所有标签页的改动一起保存，对之后新建的会话生效。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { Check, Trash2 } from "lucide-react"
import {
  localizeText,
  type AgentInstance,
  type AgentSummary,
  type AgentSettingField,
  type AgentSettingsValues,
  type AgentStatus,
} from "@pigcode/contracts"
import {
  Button,
  Input,
  Tabs,
  hostErrorMessageKey,
  toHostError,
  useLocale,
} from "@pigcode/ui-primitives"
import {
  EnvironmentEditor,
  FieldControl,
  finalEnvironment,
  readEnvironment,
  type PickPath,
} from "./agent-fields"
import { ModelsEditor, arrangeModels, type AgentModelInfo } from "./agent-models"
import { AgentOverview } from "./agent-overview"

export type { AgentModelInfo } from "./agent-models"

/** 详情面板需要的回调；保存失败时抛错，由面板展示原因。 */
export interface AgentEditorProps {
  cliUpdate?: ReactNode
  agent: AgentSummary
  /** 正在编辑的实例。 */
  instance: AgentInstance
  /** 这个实例的检测结果。 */
  status: AgentStatus | undefined
  /** 账号邮箱是否显示原文；和卡片头共用。 */
  revealed?: boolean | undefined
  onReveal?: (() => void) | undefined
  /** 这个实例的模型目录（含已保存的自定义模型）；缺少表示还在读取。 */
  models?: readonly AgentModelInfo[] | undefined
  /** 新会话默认使用的实例 id。 */
  defaultInstanceId: string | null
  onSave: (values: AgentSettingsValues) => Promise<void>
  onUpdateInstance: (
    instanceId: string,
    patch: { label?: string; enabled?: boolean },
  ) => Promise<void>
  onRemoveInstance: (instanceId: string) => Promise<void>
  onSetDefaultInstance: (instanceId: string) => Promise<void>
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

/** 留空的值：保存时 Host 会去掉，比较时当作没有。 */
function blank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  )
}

/** 两份设置是否相同；对象键顺序与留空的项不影响结果。 */
function sameValues(left: AgentSettingsValues, right: AgentSettingsValues): boolean {
  const normalize = (values: AgentSettingsValues) =>
    JSON.stringify(
      Object.keys(values)
        .filter((key) => !blank(values[key]))
        .sort()
        .map((key) => [key, values[key]]),
    )
  return normalize(left) === normalize(right)
}

/** 标签页。 */
type EditorTab = "models" | "runtime" | "env" | "instance"

/** 标签页里的一组：可选的小标题与说明，下面是内容。 */
function Block({
  title,
  description,
  children,
}: {
  title?: string | undefined
  description?: string | undefined
  children: ReactNode
}) {
  return (
    <section className="agent-block" aria-label={title}>
      {title || description ? (
        <header className="agent-block-head">
          {title ? <h3>{title}</h3> : null}
          {description ? <p className="agent-muted">{description}</p> : null}
        </header>
      ) : null}
      {children}
    </section>
  )
}

/** 渲染实例的详情面板；保存成功后以 Host 返回的值为准。 */
export function AgentEditor({
  cliUpdate,
  agent,
  instance,
  status,
  revealed = false,
  onReveal,
  models,
  defaultInstanceId,
  onSave,
  onUpdateInstance,
  onRemoveInstance,
  onSetDefaultInstance,
  onPickPath,
  onOpenExternal,
}: AgentEditorProps) {
  const { locale, t } = useLocale()
  const [draft, setDraft] = useState<AgentSettingsValues>(instance.values)
  const [label, setLabel] = useState(instance.label)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)

  // Host 推来新的值（保存成功、别处修改、切换实例）时重置草稿。
  useEffect(() => {
    setDraft(instance.values)
    setLabel(instance.label)
    setNotice(null)
    setConfirmRemove(false)
  }, [instance.instanceId, instance.label, instance.values])

  const dirty = useMemo(() => !sameValues(draft, instance.values), [draft, instance.values])
  const renamed = label.trim().length > 0 && label.trim() !== instance.label
  const runtimeFields = agent.fields.filter(
    (field): field is Exclude<AgentSettingField, { type: "env" }> => field.type !== "env",
  )
  const envFields = agent.fields.filter((field) => field.type === "env")
  const isDefault = instance.isDefault
  const isDefaultForSessions = defaultInstanceId === instance.instanceId
  const modelRows = useMemo(() => (models ? arrangeModels(models, draft) : null), [models, draft])
  const tabs: { value: EditorTab; label: string; count?: number | undefined }[] = [
    ...(agent.customModels || models
      ? [
          {
            value: "models" as const,
            label: t("agents.section.models"),
            count: modelRows?.length,
          },
        ]
      : []),
    ...(runtimeFields.length > 0
      ? [{ value: "runtime" as const, label: t("agents.section.runtime") }]
      : []),
    ...(envFields.length > 0 ? [{ value: "env" as const, label: t("agents.section.env") }] : []),
    ...(isDefault
      ? []
      : [{ value: "instance" as const, label: t("agents.instance.section.identity") }]),
  ]
  const [tab, setTab] = useState<EditorTab>(tabs[0]?.value ?? "runtime")
  const activeTab = tabs.some((item) => item.value === tab) ? tab : (tabs[0]?.value ?? tab)

  const set = (key: string, value: unknown) => patch({ [key]: value })
  const patch = (changes: Record<string, unknown>) => {
    setNotice(null)
    setDraft((current) => ({ ...current, ...changes }))
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

  /** 设为新会话默认：默认实例放在说明那一行的右边，其余实例放在「实例」一块里。 */
  const setDefaultButton = (
    <Button
      size="sm"
      variant={isDefault ? "ghost" : undefined}
      type="button"
      disabled={saving || isDefaultForSessions || !instance.enabled}
      onClick={() => void run(() => onSetDefaultInstance(instance.instanceId))}
    >
      <Check className="ic ic-sm" aria-hidden="true" />
      {isDefaultForSessions
        ? t("agents.instance.isSessionDefault")
        : t("agents.instance.setDefault")}
    </Button>
  )

  return (
    <div className="agent-editor">
      <AgentOverview
        agent={agent}
        status={status}
        revealed={revealed}
        onReveal={onReveal}
        action={isDefault ? setDefaultButton : undefined}
        onOpenExternal={onOpenExternal}
        versionControl={cliUpdate}
      />

      {tabs.length > 0 ? (
        <Tabs.Root
          className="agent-tabs"
          value={activeTab}
          onValueChange={(value) => setTab(value as EditorTab)}
        >
          <Tabs.List aria-label={t("agents.tabs")}>
            {tabs.map((item) => (
              <Tabs.Tab key={item.value} value={item.value}>
                {item.label}
                {item.count !== undefined ? <span className="tabs-count">{item.count}</span> : null}
              </Tabs.Tab>
            ))}
          </Tabs.List>

          <Tabs.Panel value="models">
            <Block description={t("agents.models.description")}>
              <ModelsEditor
                catalog={models}
                values={draft}
                allowCustom={agent.customModels}
                onChange={patch}
              />
            </Block>
          </Tabs.Panel>

          <Tabs.Panel value="runtime">
            <Block>
              <div className="agent-fields">
                {runtimeFields.map((field) => (
                  <div className="agent-field" key={field.key}>
                    <div className="agent-field-label">
                      <span>{localizeText(field.label, locale)}</span>
                      {field.description ? (
                        <span className="agent-muted">
                          {localizeText(field.description, locale)}
                        </span>
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
            </Block>
          </Tabs.Panel>

          <Tabs.Panel value="env">
            {envFields.map((field) => {
              const fieldLabel = localizeText(field.label, locale)
              return (
                <Block
                  key={field.key}
                  {...(envFields.length > 1 ? { title: fieldLabel } : {})}
                  {...(field.description
                    ? { description: localizeText(field.description, locale) }
                    : {})}
                >
                  <EnvironmentEditor
                    label={fieldLabel}
                    entries={readEnvironment(draft[field.key])}
                    onChange={(entries) => set(field.key, entries)}
                  />
                </Block>
              )
            })}
          </Tabs.Panel>

          {isDefault ? null : (
            <Tabs.Panel value="instance">
              <Block>
                <div className="agent-field">
                  <label className="agent-field-label" htmlFor="agent-instance-label">
                    <span>{t("agents.instance.name")}</span>
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
                  <p className="agent-muted">
                    {t("agents.instance.idLabel")} <code>{instance.instanceId}</code>
                  </p>
                </div>
                <div className="agent-identity-actions">
                  {setDefaultButton}
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
              </Block>
            </Tabs.Panel>
          )}
        </Tabs.Root>
      ) : null}

      <footer className="agent-actions" data-dirty={dirty || undefined}>
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
