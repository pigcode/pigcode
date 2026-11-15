/** 定时任务直接使用会话 Composer，模型选项写进任务。 */
import { useMemo } from "react"
import { MessageSquareText } from "lucide-react"
import { runtimeModeSchema, type Project, type ScheduleExecution } from "@pigcode/contracts"
import {
  Composer,
  ProjectChip,
  ProjectMenu,
  resolveModel,
  type ComposerForm,
  type ComposerProps,
} from "@pigcode/ui-composer"
import { useLocale } from "@pigcode/ui-primitives"
import type {
  ScheduleAgentOptions,
  ScheduleComposerSources,
  ScheduleThreadOption,
} from "./schedule-types"

export function ScheduleComposer({
  form,
  projects,
  projectId,
  projectLocked,
  legacy,
  execution,
  agentOptions,
  sources,
  saving,
  onAddProject,
  onProjectChange,
  onExecutionChange,
  onSubmit,
}: {
  form: ComposerForm
  projects: readonly Project[]
  projectId: string | null
  projectLocked: boolean
  legacy: { id: string; thread?: ScheduleThreadOption | undefined } | null
  execution: ScheduleExecution
  agentOptions: ScheduleAgentOptions
  sources?: ScheduleComposerSources | undefined
  saving: boolean
  onAddProject?: (() => void) | undefined
  onProjectChange: (id: string) => void
  onExecutionChange: (value: ScheduleExecution) => void
  onSubmit: ComposerProps["onSubmit"]
}) {
  const { t } = useLocale()
  const scopeProject = legacy ? (legacy.thread?.projectId ?? null) : projectId
  const legacyId = legacy?.id ?? null
  const { listFiles, threadOptions, loadCommands, workspaceControls } = sources ?? {}
  const files = useMemo(
    () => (scopeProject && listFiles ? () => listFiles(scopeProject) : undefined),
    [listFiles, scopeProject],
  )
  const threads = useMemo(
    () => threadOptions?.(scopeProject, legacyId),
    [threadOptions, scopeProject, legacyId],
  )
  const loadAgentCommands = useMemo(() => {
    const scope = legacyId
      ? { threadId: legacyId }
      : scopeProject
        ? { projectId: scopeProject }
        : null
    return loadCommands
      ? (id: string, refresh?: boolean) => loadCommands(id, scope, refresh)
      : undefined
  }, [loadCommands, legacyId, scopeProject])
  const { agents, catalog, defaultInstanceId, onLoadModels } = agentOptions
  const instanceId = legacy
    ? (legacy.thread?.lastInstanceId ?? legacy.thread?.defaultInstanceId ?? null)
    : (execution.instanceId ?? defaultInstanceId ?? null)
  const modelId = legacy ? (legacy.thread?.lastModelId ?? null) : (execution.modelId ?? null)
  const project = projects.find((item) => item.id === projectId)
  const model = resolveModel(instanceId ? catalog[instanceId] : undefined, modelId)
  const editable = !legacy && !saving

  return (
    <Composer
      tall
      form={form}
      header={
        legacy ? (
          <span
            className="chip-btn draft-project"
            data-static=""
            title={t("schedules.threadLocked")}
          >
            <MessageSquareText className="ic" aria-hidden="true" />
            <span className="truncate">
              {t("schedules.field.thread")} · {legacy.thread?.title ?? t("schedules.threadMissing")}
            </span>
          </span>
        ) : (
          <>
            {projectLocked ? (
              <ProjectChip
                name={project?.name ?? t("schedules.project.missing")}
                rootPath={project?.rootPath}
              />
            ) : (
              <ProjectMenu
                projects={projects}
                projectId={projectId}
                onSelect={onProjectChange}
                onAdd={onAddProject}
                disabled={saving}
              />
            )}
            {project
              ? workspaceControls?.({
                  projectId: project.id,
                  worktree: execution.worktree,
                  onWorktree: (value) =>
                    onExecutionChange({ ...execution, worktree: value ?? undefined }),
                  disabled: saving,
                })
              : null}
          </>
        )
      }
      placeholder={t("settings.schedules.promptPlaceholder")}
      onSubmit={onSubmit}
      onStop={() => undefined}
      disabled={saving}
      agents={agents}
      catalog={catalog}
      {...(onLoadModels ? { onLoadModels } : {})}
      agentId={instanceId}
      modelId={modelId}
      permissionMode={legacy?.thread?.permissionMode ?? execution.permissionMode}
      planMode={legacy?.thread?.planMode ?? execution.planMode ?? false}
      runOptions={{
        reset:
          editable && execution.instanceId
            ? {
                label: t("schedules.agent.default"),
                onClick: () =>
                  onExecutionChange({
                    permissionMode: execution.permissionMode,
                    ...(execution.worktree ? { worktree: execution.worktree } : {}),
                  }),
              }
            : undefined,
        value: {
          effort: execution.effort ?? null,
          fast: execution.fast ?? false,
          ultracode: execution.ultracode ?? false,
        },
        onChange: ({ effort, fast, ultracode }) => {
          if (!editable || !instanceId || !model) return
          onExecutionChange({
            ...execution,
            instanceId,
            modelId: model.id,
            effort: effort ?? undefined,
            fast: fast || undefined,
            ultracode: ultracode || undefined,
          })
        },
      }}
      {...(editable
        ? ({
            onSelectModel: (choice) => {
              if (
                choice.instanceId === execution.instanceId &&
                choice.modelId === execution.modelId
              )
                return
              onExecutionChange({
                ...execution,
                instanceId: choice.instanceId,
                modelId: choice.modelId,
                effort: undefined,
                fast: undefined,
                ultracode: undefined,
              })
            },
            onPermissionMode: (mode) =>
              onExecutionChange({ ...execution, permissionMode: runtimeModeSchema.parse(mode) }),
            onPlanMode: (planMode) =>
              onExecutionChange({
                ...execution,
                instanceId: planMode && instanceId ? instanceId : execution.instanceId,
                planMode: planMode || undefined,
              }),
          } satisfies Partial<ComposerProps>)
        : {})}
      {...(files ? { files } : {})}
      {...(threads ? { threads } : {})}
      {...(loadAgentCommands ? { loadAgentCommands } : {})}
    />
  )
}
