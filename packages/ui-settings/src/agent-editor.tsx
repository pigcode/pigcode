/**
 * 选中的 Agent 的设置，参照 t3code 的 Agent 设置：头部是图标、名字和版本；下面分组，
 * 每组一个小标题加几行——状态和名字、模型、启动设置、自动压缩、环境变量，最后是其他
 * （程序位置、ID、恢复默认、删除）。改动先进草稿，有没保存的改动时底部浮出保存条。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  localizeText,
  type AgentInstance,
  type AgentSummary,
  type AgentSettingsValues,
  type AgentStatus,
} from "@pigcode/contracts"
import {
  AgentIcon,
  Button,
  formatShortcut,
  hostErrorMessageKey,
  toHostError,
  useLocale,
} from "@pigcode/ui-primitives"
import {
  AgentFields,
  EnvironmentEditor,
  cleanAgentValues,
  readEnvironment,
  type PickPath,
} from "./agent-fields"
import { ModelsEditor, type AgentModelInfo } from "./agent-models"
import { ClaudeCompactionSettings, type ClaudeDefaults } from "./claude-compaction-settings"
import { mergeDraftValues, sameValues, type InstanceEdits } from "./instance-edits"
import { AgentCommand, AgentStatusRow } from "./agent-overview"
import { InstanceIdRow, InstanceNameRow, RemoveRow, ResetRow } from "./agent-instance-panel"
import { AgentBlockRow, AgentSection } from "./agent-section"

export type { AgentModelInfo } from "./agent-models"

/** 保存成功的提示停留多久后收起保存条。 */
const SAVED_NOTICE_MS = 2400

/** 设置需要的回调；保存失败时抛错，由设置自己展示原因。 */
export interface AgentEditorProps {
  edits: InstanceEdits
  idleDefaults?: ClaudeDefaults | undefined
  cliUpdate?: ReactNode
  setup?: ReactNode
  agent: AgentSummary
  /** 正在编辑的实例。 */
  instance: AgentInstance
  /** 列表里显示的名字：默认实例跟随 agent 的名字。 */
  label: string
  /** 这个实例的检测结果。 */
  status: AgentStatus | undefined
  /** 账号邮箱是否显示原文。 */
  revealed?: boolean | undefined
  onReveal?: (() => void) | undefined
  /** 这个实例的模型目录（含已保存的自定义模型）；缺少表示还在读取。 */
  models?: readonly AgentModelInfo[] | undefined
  onSave: (values: AgentSettingsValues) => Promise<void>
  onUpdateInstance: (
    instanceId: string,
    patch: { label?: string; enabled?: boolean; accentColor?: string | null },
  ) => Promise<void>
  onRemoveInstance: (instanceId: string) => Promise<void>
  onPickPath?: PickPath | undefined
}

/** 渲染一个 Agent 的设置；保存成功后以 Host 返回的值为准。 */
export function AgentEditor({
  edits: pending,
  idleDefaults,
  cliUpdate,
  setup,
  agent,
  instance,
  label: displayName,
  status,
  revealed = false,
  onReveal,
  models,
  onSave,
  onUpdateInstance,
  onRemoveInstance,
  onPickPath,
}: AgentEditorProps) {
  const { locale, t } = useLocale()
  const { values: edits, setValues: setEdits, label: editedName, color: editedColor } = pending
  const draft = useMemo(() => mergeDraftValues(instance.values, edits), [edits, instance.values])
  const label = editedName ?? instance.label
  const color = editedColor === null ? undefined : (editedColor ?? instance.accentColor)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null)

  const isDefault = instance.isDefault
  const valuesDirty = useMemo(() => !sameValues(draft, instance.values), [draft, instance.values])
  const nameChanged = !isDefault && label.trim() !== instance.label
  const colorChanged = !isDefault && color !== instance.accentColor
  const identityDirty = nameChanged || colorChanged
  const invalidLabel = !isDefault && label.trim() === ""
  const anyDirty = valuesDirty || identityDirty
  const version = status?.installed ? status.version : null

  const claudeContext =
    agent.agentId === "claude" && agent.fields.some((field) => field.key === "idleCompaction")
  const runtimeFields = agent.fields.filter(
    (field) =>
      field.visibility !== "hidden" &&
      !(claudeContext && (field.key === "idleCompaction" || field.key === "autoCompactWindow")) &&
      !(
        agent.agentId === "codex" &&
        draft.setupMode === "managed" &&
        field.key === "shadowHomePath"
      ) &&
      field.type !== "env" &&
      (!agent.acpRegistry || field.key !== "registryId"),
  )
  const envFields = agent.fields.filter((field) => field.type === "env")

  const patch = (changes: Record<string, unknown>) => {
    setNotice(null)
    setEdits((current) => {
      const next = { ...current }
      for (const [key, value] of Object.entries(changes)) {
        if (sameValues({ [key]: instance.values[key] }, { [key]: value })) delete next[key]
        else next[key] = value
      }
      return next
    })
  }
  const set = (key: string, value: unknown) => patch({ [key]: value })

  const failureText = useCallback(
    (error: unknown): string => {
      const info = toHostError(error)
      const key = hostErrorMessageKey(info.code)
      return key ? t(key) : t("agents.failed").replace("{reason}", info.message)
    },
    [t],
  )

  const run = useCallback(
    async (action: () => Promise<void>): Promise<void> => {
      setSaving(true)
      setNotice(null)
      try {
        await action()
      } catch (error) {
        setNotice({ kind: "error", text: failureText(error) })
      } finally {
        setSaving(false)
      }
    },
    [failureText],
  )

  const save = useCallback(async (): Promise<void> => {
    if (!anyDirty || saving || invalidLabel) return
    let cleaned: AgentSettingsValues | null = null
    if (valuesDirty) {
      cleaned = cleanAgentValues(agent.fields, draft)
      if (!cleaned) {
        setNotice({ kind: "error", text: t("agents.settings.invalid") })
        return
      }
    }
    const snapshotEdits = edits
    await run(async () => {
      if (identityDirty) {
        await onUpdateInstance(instance.instanceId, {
          ...(nameChanged ? { label: label.trim() } : {}),
          ...(colorChanged ? { accentColor: color ?? null } : {}),
        })
        pending.clearSavedIdentity()
      }
      if (valuesDirty && cleaned) {
        await onSave(cleaned)
        setEdits((current) =>
          Object.fromEntries(
            Object.entries(current).filter(
              ([key, value]) => !Object.hasOwn(snapshotEdits, key) || value !== snapshotEdits[key],
            ),
          ),
        )
      }
      setNotice({ kind: "ok", text: t("agents.saved") })
    })
  }, [
    agent.fields,
    anyDirty,
    color,
    colorChanged,
    draft,
    edits,
    identityDirty,
    instance.instanceId,
    invalidLabel,
    label,
    nameChanged,
    onSave,
    onUpdateInstance,
    pending,
    run,
    saving,
    setEdits,
    t,
    valuesDirty,
  ])

  // ⌘S / Ctrl+S 快捷保存没保存的改动。
  useEffect(() => {
    if (!anyDirty || saving || invalidLabel) return
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault()
        void save()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [anyDirty, invalidLabel, save, saving])

  // 保存成功的提示停一会儿就收起；还有新的改动时保存条留着。
  useEffect(() => {
    if (notice?.kind !== "ok") return
    const timer = window.setTimeout(() => setNotice(null), SAVED_NOTICE_MS)
    return () => window.clearTimeout(timer)
  }, [notice])

  const shortcut = formatShortcut("Mod+S")
  const headName = isDefault ? displayName : label.trim() || instance.label

  return (
    <div className="agent-editor">
      <div className="agent-section agent-overview">
        <header className="agent-section-head agent-head">
          <AgentIcon
            agentId={agent.agentId}
            instanceId={instance.instanceId}
            accentColor={color}
            name={headName}
            size="lg"
          />
          <h3 id="agent-detail-title">{headName}</h3>
          {version ? <span className="agent-head-version">{cliUpdate ?? version}</span> : null}
        </header>
        <div className="agent-rows">
          <AgentStatusRow
            agent={agent}
            instance={instance}
            status={status}
            revealed={revealed}
            onReveal={onReveal}
            setup={setup}
          />
          {isDefault ? null : (
            <InstanceNameRow
              label={label}
              color={color}
              invalidLabel={invalidLabel}
              saving={saving}
              onLabelChange={(value) => {
                setNotice(null)
                pending.setIdentity({ label: value === instance.label ? undefined : value })
              }}
              onColorChange={(value) => {
                setNotice(null)
                pending.setIdentity({
                  color: value === instance.accentColor ? undefined : (value ?? null),
                })
              }}
            />
          )}
        </div>
      </div>

      {agent.customModels || models ? (
        <ModelsEditor
          catalog={models}
          values={draft}
          allowCustom={agent.customModels}
          onChange={patch}
        />
      ) : null}

      {runtimeFields.length > 0 ? (
        <AgentSection title={t("agents.section.runtime")}>
          <AgentFields
            references={agent.secretReferences}
            fields={runtimeFields}
            values={draft}
            onChange={set}
            onPickPath={onPickPath}
          />
        </AgentSection>
      ) : null}

      {claudeContext ? (
        <AgentSection title={t("agents.claude.context")}>
          <ClaudeCompactionSettings
            defaultPolicy={idleDefaults?.value}
            onChangeDefault={idleDefaults?.set}
            values={draft}
            threshold={agent.fields.find((field) => field.key === "autoCompactWindow")}
            onChange={set}
          />
        </AgentSection>
      ) : null}

      {envFields.map((field) => {
        const fieldLabel = localizeText(field.label, locale)
        return (
          <AgentSection
            key={field.key}
            title={envFields.length > 1 ? fieldLabel : t("agents.section.env")}
          >
            <AgentBlockRow
              description={
                field.description ? localizeText(field.description, locale) : t("agents.env.hint")
              }
            >
              <EnvironmentEditor
                references={agent.secretReferences}
                label={fieldLabel}
                entries={readEnvironment(draft[field.key])}
                onChange={(entries) => set(field.key, entries)}
              />
            </AgentBlockRow>
          </AgentSection>
        )
      })}

      <AgentSection title={t("agents.section.other")}>
        <AgentCommand command={status?.command} />
        {isDefault ? null : <InstanceIdRow instance={instance} />}
        <ResetRow
          disabled={Object.keys(draft).length === 0 || saving}
          onReset={() => {
            setNotice(null)
            setEdits(
              Object.fromEntries(Object.keys(instance.values).map((key) => [key, undefined])),
            )
          }}
        />
        {isDefault ? null : (
          <RemoveRow
            saving={saving}
            onRemove={() => void run(() => onRemoveInstance(instance.instanceId))}
          />
        )}
      </AgentSection>

      {anyDirty || notice ? (
        <div className="agent-savebar" data-tone={notice?.kind}>
          <span className="agent-savebar-status" role="status">
            {notice ? (
              notice.text
            ) : (
              <>
                <span className="agent-dirty-dot" aria-hidden="true" />
                {t("agents.unsaved")}
              </>
            )}
          </span>
          <span className="spacer" />
          {anyDirty ? (
            <Button
              size="md"
              variant="ghost"
              type="button"
              disabled={saving}
              onClick={() => {
                setNotice(null)
                pending.discard()
              }}
            >
              {t("agents.revert")}
            </Button>
          ) : null}
          <Button
            size="md"
            variant="primary"
            type="button"
            disabled={!anyDirty || saving || invalidLabel}
            onClick={() => void save()}
          >
            <span>{saving ? t("agents.saving") : t("agents.save")}</span>
            {anyDirty && !saving ? (
              <kbd className="agent-save-kbd" aria-hidden="true">
                {shortcut}
              </kbd>
            ) : null}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
