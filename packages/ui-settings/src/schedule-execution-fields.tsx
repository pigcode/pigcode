/** 指令下方的运行设置；项目在创建后固定，其他设置对下一次运行生效。 */
import { Bot, FolderOpen, FolderPlus } from "lucide-react"
import {
  RUNTIME_MODE_OPTIONS,
  runtimeModeSchema,
  type Project,
  type ScheduleExecution,
} from "@pigcode/contracts"
import { PermissionMenu, effortLabel } from "@pigcode/ui-composer"
import { Button, useLocale } from "@pigcode/ui-primitives"
import { useEffect } from "react"
import { ChoiceSelect } from "./choice-select"
import type { ScheduleAgentOptions } from "./schedule-types"

export function ScheduleExecutionFields({
  projects,
  projectId,
  projectLocked,
  onProjectChange,
  onAddProject,
  value,
  onChange,
  agentOptions,
  disabled,
}: {
  projects: readonly Project[]
  projectId: string
  projectLocked: boolean
  onProjectChange: (id: string) => void
  onAddProject?: (() => void) | undefined
  value: ScheduleExecution
  onChange: (value: ScheduleExecution) => void
  agentOptions: ScheduleAgentOptions
  disabled: boolean
}) {
  const { t } = useLocale()
  const { agents, catalog, onLoadModels } = agentOptions
  const { instanceId, modelId, effort, permissionMode } = value
  const project = projects.find((item) => item.id === projectId)
  const selectedAgent = agents.find((agent) => agent.id === instanceId)
  const models = instanceId ? catalog[instanceId] : undefined
  const selectedModel = models?.find((model) => model.id === modelId)
  const installable = agents.filter((agent) => agent.installed !== false || agent.id === instanceId)
  const visibleModels = models?.filter((model) => !model.hidden || model.id === modelId) ?? []

  useEffect(() => {
    if (selectedAgent && !models) onLoadModels?.(selectedAgent.id)
  }, [models, onLoadModels, selectedAgent])

  return (
    <div className="schedule-execution" role="group" aria-label={t("schedules.execution.label")}>
      {projectLocked ? (
        <span className="schedule-project-locked" title={t("schedules.project.locked")}>
          <FolderOpen className="ic ic-sm" aria-hidden="true" />
          <span className="truncate">{project?.name ?? t("schedules.project.missing")}</span>
        </span>
      ) : projects.length > 0 ? (
        <ChoiceSelect
          label={t("schedules.field.project")}
          value={projectId}
          options={projects.map((item) => ({ value: item.id, label: item.name }))}
          variant="pill"
          icon={FolderOpen}
          disabled={disabled}
          onChange={onProjectChange}
        />
      ) : onAddProject ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={disabled}
          onClick={onAddProject}
        >
          <FolderPlus className="ic ic-sm" aria-hidden="true" />
          {t("nav.addProject")}
        </Button>
      ) : (
        <span className="hint">{t("schedules.project.required")}</span>
      )}
      <ChoiceSelect
        label={t("schedules.field.agent")}
        value={instanceId ?? ""}
        options={[
          { value: "", label: t("schedules.agent.default") },
          ...(instanceId && !selectedAgent
            ? [{ value: instanceId, label: t("schedules.agent.missing") }]
            : []),
          ...installable.map((agent) => ({ value: agent.id, label: agent.label })),
        ]}
        variant="pill"
        icon={Bot}
        disabled={disabled}
        onChange={(id) => onChange({ ...(id ? { instanceId: id } : {}), permissionMode })}
      />
      {instanceId && (visibleModels.length > 0 || modelId) ? (
        <ChoiceSelect
          label={t("schedules.field.model")}
          value={modelId ?? ""}
          options={[
            { value: "", label: t("schedules.model.default") },
            ...(modelId && !selectedModel ? [{ value: modelId, label: modelId }] : []),
            ...visibleModels.map((model) => ({ value: model.id, label: model.label })),
          ]}
          variant="pill"
          disabled={disabled}
          onChange={(id) =>
            onChange({ instanceId, ...(id ? { modelId: id } : {}), permissionMode })
          }
        />
      ) : null}
      {selectedModel && selectedModel.efforts.length > 0 ? (
        <ChoiceSelect
          label={t("schedules.field.effort")}
          value={effort ?? ""}
          options={[
            { value: "", label: t("schedules.effort.default") },
            ...selectedModel.efforts.map((id) => ({ value: id, label: effortLabel(id, t) })),
          ]}
          variant="pill"
          disabled={disabled}
          onChange={(id) => onChange({ ...value, effort: id || undefined })}
        />
      ) : null}
      <PermissionMenu
        value={permissionMode}
        modes={RUNTIME_MODE_OPTIONS}
        side="bottom"
        shortcutHint={false}
        onChange={
          disabled
            ? undefined
            : (mode) => onChange({ ...value, permissionMode: runtimeModeSchema.parse(mode) })
        }
      />
    </div>
  )
}
