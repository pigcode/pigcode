// Agent 设置表单的控件：按 manifest 声明的字段类型渲染，另有环境变量编辑器。模型列表在 agent-models。
import { FolderOpen } from "lucide-react"
import { CredentialField, LiteralArguments, EnvironmentEditor } from "./agent-credential-fields"
export { EnvironmentEditor } from "./agent-credential-fields"
import {
  environmentEntriesSchema,
  localizeText,
  secretInputSchema,
  type AgentSettingsValues,
  type EnvironmentEntry,
  type AgentSettingField,
} from "@pigcode/contracts"
import { Button, Input, Select, Switch, useLocale } from "@pigcode/ui-primitives"

/** 选择文件或文件夹；返回选中的路径，取消时为 null。 */
export type PickPath = (kind: "file" | "directory") => Promise<string | null>

/**
 * 把草稿里的值读成环境变量行：编辑中的行可能还没有名字或名字不合法，照样保留，
 * 名字的校验在输入框上提示、保存时由 Host 把关。
 */
export function readEnvironment(value: unknown): EnvironmentEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry: unknown) => {
    const record = entry as EnvironmentEntry | null
    if (
      typeof record?.name !== "string" ||
      (typeof record.value !== "string" && (!record.value || typeof record.value !== "object"))
    )
      return []
    return [record]
  })
}

/** 保存前的环境变量：去掉没填名字的行；名字不合法时返回 null，让调用方提示而不是提交。 */
function finalEnvironment(value: unknown): EnvironmentEntry[] | null {
  const entries = readEnvironment(value).filter((entry) => entry.name !== "")
  return environmentEntriesSchema.safeParse(entries).success ? entries : null
}

/** 去掉没填名字的变量行，变量名不合法时请调用方留在表单里。 */
export function cleanAgentValues(
  fields: readonly AgentSettingField[],
  values: AgentSettingsValues,
): AgentSettingsValues | null {
  const next = { ...values }
  for (const field of fields) {
    const value = values[field.key]
    if (
      field.type === "secret" &&
      value &&
      typeof value !== "string" &&
      !secretInputSchema.safeParse(value).success
    )
      return null
    if (
      field.type === "text" &&
      field.integerRange &&
      typeof value === "string" &&
      value &&
      (!/^\d+$/.test(value) ||
        Number(value) < field.integerRange.min ||
        Number(value) > field.integerRange.max)
    )
      return null
    if (field.type !== "env" || values[field.key] === undefined) continue
    const entries = finalEnvironment(values[field.key])
    if (!entries) return null
    next[field.key] = entries
  }
  return next
}

/** 运行设置与向导中的配置字段都由 Agent 的 manifest 决定。 */
export function AgentFields({
  fields,
  values,
  onChange,
  references,
  onPickPath,
}: {
  fields: readonly AgentSettingField[]
  values: AgentSettingsValues
  onChange: (key: string, value: unknown) => void
  references?: boolean | undefined
  onPickPath?: PickPath | undefined
}) {
  const { locale } = useLocale()
  return (
    <div className="agent-fields">
      {fields
        .filter((f) => f.visibility !== "hidden")
        .map((field) => {
          const label = localizeText(field.label, locale)
          return (
            <div className="agent-field" key={field.key}>
              <div className="agent-field-label">
                <span>{label}</span>
                {field.description ? (
                  <span className="agent-muted">{localizeText(field.description, locale)}</span>
                ) : null}
              </div>
              {field.type === "env" ? (
                <EnvironmentEditor
                  label={label}
                  references={references}
                  entries={readEnvironment(values[field.key])}
                  onChange={(entries) => onChange(field.key, entries)}
                />
              ) : (
                <FieldControl
                  references={references}
                  field={field}
                  value={values[field.key]}
                  onChange={(value) => onChange(field.key, value)}
                  onPickPath={onPickPath}
                />
              )}
            </div>
          )
        })}
    </div>
  )
}

/** 一个字段的控件。env 字段由 EnvironmentEditor 单独渲染。 */
function FieldControl({
  field,
  value,
  onChange,
  references,
  onPickPath,
}: {
  field: Exclude<AgentSettingField, { type: "env" }>
  value: unknown
  onChange: (value: unknown) => void
  references?: boolean | undefined
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
        <Select.Trigger className="input select-trigger" data-size="xl" aria-label={label}>
          <Select.Value className="grow truncate" />
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner sideOffset={6} alignItemWithTrigger={false}>
            <Select.Popup>
              {field.options.map((option) => (
                <Select.Item key={option.value} value={option.value}>
                  <Select.ItemText>{localizeText(option.label, locale)}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
    )
  }
  if (field.type === "arguments")
    return <LiteralArguments label={label} value={value} onChange={onChange} />
  if (field.type === "secret")
    return (
      <CredentialField label={label} value={value} references={references} onChange={onChange} />
    )
  const placeholder = field.placeholder ? localizeText(field.placeholder, locale) : undefined
  const pathKind = field.type === "path" ? field.pathKind : null
  return (
    <div className="agent-input-row">
      <Input
        size="xl"
        className={field.type === "text" && field.monospace ? "mono" : undefined}
        aria-label={label}
        value={typeof value === "string" ? value : ""}
        placeholder={placeholder}
        aria-invalid={
          field.type === "text" && field.integerRange && typeof value === "string" && value !== ""
            ? !/^\d+$/.test(value) ||
              Number(value) < field.integerRange.min ||
              Number(value) > field.integerRange.max
            : undefined
        }
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
      {pathKind && onPickPath ? (
        <Button
          size="lg"
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
