// Agent 设置表单的控件：按 manifest 声明的字段类型渲染，另有环境变量与自定义模型编辑器。
import { useState, type KeyboardEvent } from "react"
import { FolderOpen, Plus, X } from "lucide-react"
import {
  environmentEntriesSchema,
  localizeText,
  type EnvironmentEntry,
  type ProviderSettingField,
} from "@pigcode/contracts"
import { Button, Input, Select, Switch, useLocale } from "@pigcode/ui-primitives"

/** 选择文件或文件夹；返回选中的路径，取消时为 null。 */
export type PickPath = (kind: "file" | "directory") => Promise<string | null>

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 把草稿里的值读成环境变量行：编辑中的行可能还没有名字或名字不合法，照样保留，
 * 名字的校验在输入框上提示、保存时由 Host 把关。
 */
export function readEnvironment(value: unknown): EnvironmentEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry: unknown) => {
    const record = entry as { name?: unknown; value?: unknown } | null
    return typeof record?.name === "string" && typeof record.value === "string"
      ? [{ name: record.name, value: record.value }]
      : []
  })
}

/** 保存前的环境变量：去掉没填名字的行；名字不合法时返回 null，让调用方提示而不是提交。 */
export function finalEnvironment(value: unknown): EnvironmentEntry[] | null {
  const entries = readEnvironment(value).filter((entry) => entry.name !== "")
  return environmentEntriesSchema.safeParse(entries).success ? entries : null
}

/** 一个字段的控件。env 字段由 EnvironmentEditor 单独渲染。 */
export function FieldControl({
  field,
  value,
  onChange,
  onPickPath,
}: {
  field: Exclude<ProviderSettingField, { type: "env" }>
  value: unknown
  onChange: (value: unknown) => void
  onPickPath?: PickPath | undefined
}) {
  const { locale, t } = useLocale()
  const label = localizeText(field.label, locale)
  if (field.type === "boolean") {
    return (
      <Switch
        aria-label={label}
        checked={typeof value === "boolean" ? value : (field.default ?? false)}
        onCheckedChange={(checked) => onChange(checked)}
      />
    )
  }
  if (field.type === "select") {
    const current = typeof value === "string" ? value : (field.default ?? field.options[0]?.value)
    return (
      <Select.Root value={current ?? null} onValueChange={(next) => onChange(next)}>
        <Select.Trigger className="input agent-select" aria-label={label}>
          <Select.Value className="grow" />
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner
            className="menu-positioner"
            sideOffset={6}
            alignItemWithTrigger={false}
          >
            <Select.Popup className="menu-popup">
              {field.options.map((option) => (
                <Select.Item key={option.value} value={option.value} className="menu-item">
                  <Select.ItemText>{localizeText(option.label, locale)}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
    )
  }
  const placeholder = field.placeholder ? localizeText(field.placeholder, locale) : undefined
  const pathKind = field.type === "path" ? field.pathKind : null
  return (
    <div className="agent-input-row">
      <Input
        className={field.type === "text" && field.monospace ? "agent-input mono" : "agent-input"}
        aria-label={label}
        value={typeof value === "string" ? value : ""}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
      {pathKind && onPickPath ? (
        <Button
          size="sm"
          type="button"
          aria-label={`${t("agents.browse")} ${label}`}
          onClick={() => {
            void onPickPath(pathKind).then((picked) => {
              if (picked) onChange(picked)
            })
          }}
        >
          <FolderOpen className="ic ic-sm" aria-hidden="true" />
          {t("agents.browse")}
        </Button>
      ) : null}
    </div>
  )
}

/** 环境变量编辑器：每行一个变量名与值；变量名不合法时标红提示，保存时由 Host 再校验。 */
export function EnvironmentEditor({
  label,
  entries,
  onChange,
}: {
  label: string
  entries: readonly EnvironmentEntry[]
  onChange: (entries: EnvironmentEntry[]) => void
}) {
  const { t } = useLocale()
  const update = (index: number, patch: Partial<EnvironmentEntry>) =>
    onChange(entries.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)))
  const invalid = entries.some((entry) => entry.name !== "" && !ENV_NAME.test(entry.name))
  return (
    <div className="agent-env" role="group" aria-label={label}>
      {entries.length === 0 ? <p className="agent-muted">{t("agents.env.empty")}</p> : null}
      {entries.map((entry, index) => (
        <div className="agent-env-row" key={index}>
          <Input
            className={
              entry.name !== "" && !ENV_NAME.test(entry.name)
                ? "agent-input mono is-error"
                : "agent-input mono"
            }
            aria-label={`${t("agents.env.name")} ${index + 1}`}
            placeholder={t("agents.env.name")}
            value={entry.name}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => update(index, { name: event.target.value.trim() })}
          />
          <Input
            className="agent-input mono"
            aria-label={`${t("agents.env.value")} ${index + 1}`}
            placeholder={t("agents.env.value")}
            value={entry.value}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <Button
            variant="ghost"
            size="icon"
            type="button"
            aria-label={`${t("agents.env.remove")} ${entry.name || index + 1}`}
            onClick={() => onChange(entries.filter((_entry, at) => at !== index))}
          >
            <X className="ic ic-sm" aria-hidden="true" />
          </Button>
        </div>
      ))}
      {invalid ? <p className="error-text">{t("agents.env.invalid")}</p> : null}
      <Button
        size="sm"
        variant="ghost"
        type="button"
        className="agent-add"
        onClick={() => onChange([...entries, { name: "", value: "" }])}
      >
        <Plus className="ic ic-sm" aria-hidden="true" />
        {t("agents.env.add")}
      </Button>
    </div>
  )
}

/** 自定义模型编辑器：列表加一个输入框，回车或点「添加」追加。 */
export function CustomModelsEditor({
  models,
  onChange,
}: {
  models: readonly string[]
  onChange: (models: string[]) => void
}) {
  const { t } = useLocale()
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)

  function add(): void {
    const id = draft.trim()
    if (!id) return
    if (models.includes(id)) {
      setError(t("agents.models.duplicate"))
      return
    }
    onChange([...models, id])
    setDraft("")
    setError(null)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return
    event.preventDefault()
    add()
  }

  return (
    <div className="agent-models">
      <p className="agent-muted">{t("agents.models.description")}</p>
      {models.length > 0 ? (
        <ul className="agent-model-list" aria-label={t("agents.section.models")}>
          {models.map((model) => (
            <li key={model} className="agent-model-chip">
              <span className="mono">{model}</span>
              <button
                type="button"
                aria-label={t("agents.models.remove").replace("{model}", model)}
                onClick={() => onChange(models.filter((item) => item !== model))}
              >
                <X className="ic ic-sm" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="agent-input-row">
        <Input
          className="agent-input mono"
          aria-label={t("agents.models.placeholder")}
          placeholder={t("agents.models.placeholder")}
          value={draft}
          maxLength={256}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setDraft(event.target.value)
            setError(null)
          }}
          onKeyDown={onKeyDown}
        />
        <Button size="sm" type="button" disabled={!draft.trim()} onClick={add}>
          {t("agents.models.add")}
        </Button>
      </div>
      {error ? <p className="error-text">{error}</p> : null}
    </div>
  )
}
