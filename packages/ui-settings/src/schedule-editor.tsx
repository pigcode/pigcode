/**
 * 定时任务的编辑页：新建与编辑都在这一页。上面是返回定时任务的面包屑、标题和一条操作栏（编辑时左边是
 * 「设置 / 历史」页签，右边是立即运行和更多操作），下面是表单或运行历史。
 * 有没保存的修改时离开要先确认；保存成功后回到列表。
 */
import { useEffect, useState } from "react"
import { Ellipsis, Pause, Play, Trash2 } from "lucide-react"
import {
  DEFAULT_RUNTIME_MODE,
  type HostSummary,
  type Project,
  type Schedule,
  type ScheduleExecution,
  type SchedulePromptDraft,
  type ScheduleRule,
  type ScheduleStatus,
} from "@pigcode/contracts"
import type { ComposerDraft, ComposerSubmitOptions } from "@pigcode/ui-composer"
import {
  Button,
  Input,
  Menu,
  PageCrumbs,
  StatusDot,
  toHostError,
  useLocale,
  type StatusTone,
} from "@pigcode/ui-primitives"
import { ScheduleConfirmDialog } from "./schedule-confirm-dialog"
import { ScheduleComposer } from "./schedule-composer"
import { ScheduleHistory, type ScheduleRunsPage } from "./schedule-history"
import { ScheduleHostField } from "./schedule-host-field"
import { STATUS_KEYS, fill, formatWhen, runReason } from "./schedule-format"
import { ScheduleRuleField, type RuleValue } from "./schedule-rule-field"
import type {
  CreateScheduleInput,
  RunNowResult,
  ScheduleAgentOptions,
  ScheduleComposerSources,
  ScheduleThreadOption,
  UpdateScheduleInput,
} from "./schedule-types"

/** 新建时预填的内容：来自模板，或者空白。 */
export interface ScheduleDraft {
  title: string
  prompt: string
  rule: ScheduleRule
}

export interface ScheduleEditorProps {
  /** 编辑的任务；新建时为 null。 */
  schedule: Schedule | null
  draft: ScheduleDraft
  threads: ScheduleThreadOption[]
  projects: readonly Project[]
  preferredProjectId?: string | null | undefined
  hosts?: readonly HostSummary[] | undefined
  targetHostId?: string | undefined
  onTargetHostChange?: ((hostId: string) => void) | undefined
  scheduleHost?: HostSummary | undefined
  agentOptions: ScheduleAgentOptions
  composerSources?: ScheduleComposerSources | undefined
  onAddProject?: (() => void) | undefined
  historyRevision?: number | undefined
  onBack: () => void
  onCreate: (input: CreateScheduleInput) => Promise<unknown>
  onUpdate: (id: string, patch: UpdateScheduleInput) => Promise<unknown>
  onDelete: (id: string) => Promise<unknown>
  onRunNow: (id: string) => Promise<RunNowResult>
  onLoadRuns: (id: string, offset: number, limit: number) => Promise<ScheduleRunsPage>
  onDeleteRun: (runId: string) => Promise<unknown>
  onOpenThread?: ((threadId: string) => void) | undefined
}

export const STATUS_TONES: Record<ScheduleStatus, StatusTone> = {
  active: "ready",
  paused: "idle",
  completed: "idle",
}

const RUN_NOW_KEYS = {
  started: "schedules.runNow.started",
  busy: "schedules.runNow.busy",
  unavailable: "schedules.runNow.unavailable",
  failed: "schedules.runNow.failed",
} as const

/** 表单里可以比较的字段；和打开时不一样就是有没保存的修改。 */
function signature(fields: {
  title: string
  execution: ScheduleExecution
  prompt: ComposerDraft
  value: RuleValue
}): string {
  return JSON.stringify([
    fields.title.trim(),
    fields.prompt.text.trim(),
    fields.prompt.document,
    fields.value.rule,
    fields.value.endsAt,
    executionSignature(fields.execution),
  ])
}

function executionSignature(value: ScheduleExecution) {
  return JSON.stringify([
    value.instanceId,
    value.modelId,
    value.effort,
    value.fast,
    value.ultracode,
    value.permissionMode,
    value.planMode,
    value.worktree,
  ])
}

export function ScheduleEditor({
  schedule,
  draft,
  threads,
  projects,
  preferredProjectId,
  hosts,
  targetHostId,
  onTargetHostChange,
  scheduleHost,
  agentOptions,
  composerSources,
  onAddProject,
  historyRevision = 0,
  onBack,
  onCreate,
  onUpdate,
  onDelete,
  onRunNow,
  onLoadRuns,
  onDeleteRun,
  onOpenThread,
}: ScheduleEditorProps) {
  const { t, locale } = useLocale()
  const hostOffline = Boolean(scheduleHost && scheduleHost.status !== "connected")
  const target = schedule?.target
  const [initial] = useState(() => ({
    title: schedule?.title ?? draft.title,
    execution:
      target?.kind === "project" ? target.execution : { permissionMode: DEFAULT_RUNTIME_MODE },
    prompt: { text: schedule?.prompt ?? draft.prompt, document: schedule?.draft?.document },
    value: { rule: schedule?.rule ?? draft.rule, endsAt: schedule?.endsAt ?? null },
  }))
  const [tab, setTab] = useState<"settings" | "history">("settings")
  const [title, setTitle] = useState(initial.title)
  const [pickedProjectId, setPickedProjectId] = useState<string | null>(null)
  const [execution, setExecution] = useState<ScheduleExecution>(initial.execution)
  const [prompt, setPrompt] = useState<ComposerDraft>(initial.prompt)
  const [value, setValue] = useState<RuleValue>(initial.value)
  const [ruleValid, setRuleValid] = useState(true)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "warn" } | null>(null)
  const [confirm, setConfirm] = useState<"discard" | "delete" | null>(null)
  const [localRevision, setLocalRevision] = useState(0)

  // 立即运行的结果显示几秒后自己消失。
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 4_000)
    return () => clearTimeout(timer)
  }, [notice])

  const defaultProjectId =
    projects.find((project) => project.id === preferredProjectId)?.id ?? projects[0]?.id ?? ""
  const projectId =
    target?.kind === "project"
      ? target.projectId
      : (projects.find((project) => project.id === pickedProjectId)?.id ?? defaultProjectId)
  const dirty =
    signature({ title, execution, prompt, value }) !== signature(initial) ||
    (!schedule && projectId !== defaultProjectId)
  const canSave = !saving && ruleValid && (schedule ? dirty : projectId !== "")
  const ruleUnchanged =
    schedule !== null &&
    JSON.stringify([value.rule, value.endsAt]) === JSON.stringify([schedule.rule, schedule.endsAt])
  const pinned = ruleUnchanged && schedule?.status === "active" ? schedule.nextRunAt : undefined

  function requestBack(): void {
    if (saving) return
    if (dirty) setConfirm("discard")
    else onBack()
  }

  async function submit(text: string, options: ComposerSubmitOptions): Promise<void> {
    if (!canSave || !text.trim()) return
    setSaving(true)
    setFailure(null)
    const savedDraft: SchedulePromptDraft | undefined = options.document
      ? {
          document: options.document,
          ...(options.references
            ? { references: options.references.map(({ kind, threadId }) => ({ kind, threadId })) }
            : {}),
        }
      : undefined
    try {
      if (schedule) {
        const patch: UpdateScheduleInput = {}
        if (title.trim() !== schedule.title) patch.title = title.trim()
        if (text !== schedule.prompt || prompt.document !== initial.prompt.document) {
          patch.prompt = text
          patch.draft = savedDraft ?? null
        }
        if (!ruleUnchanged) {
          patch.rule = value.rule
          patch.endsAt = value.endsAt
        }
        if (
          target?.kind === "project" &&
          executionSignature(execution) !== executionSignature(target.execution)
        ) {
          patch.execution = execution
        }
        await onUpdate(schedule.id, patch)
      } else {
        await onCreate({
          projectId,
          execution,
          title: title.trim(),
          prompt: text,
          ...(savedDraft ? { draft: savedDraft } : {}),
          rule: value.rule,
          endsAt: value.endsAt,
          enabled: true,
        })
      }
      onBack()
    } catch (cause) {
      const message = toHostError(cause).message
      setFailure(fill(t("schedules.failed"), { reason: runReason(message, t) ?? message }))
      setSaving(false)
    }
  }

  function runNow(): void {
    if (!schedule) return
    void onRunNow(schedule.id).then(
      (result) => {
        setNotice({
          text: t(RUN_NOW_KEYS[result.status]),
          tone: result.status === "started" ? "ok" : "warn",
        })
        setLocalRevision((current) => current + 1)
      },
      () => setNotice({ text: t("schedules.runNow.failed"), tone: "warn" }),
    )
  }

  const legacyThreadId = target?.kind === "thread" ? target.threadId : null
  const legacyThread = threads.find((thread) => thread.id === legacyThreadId)
  const heading = schedule ? t("schedules.editor.editTitle") : t("schedules.editor.createTitle")
  const status = schedule?.status
  return (
    <div className="page schedule-editor">
      <PageCrumbs
        back={t("schedules.editor.back")}
        backLabel={t("schedules.editor.backLabel")}
        onBack={requestBack}
        current={schedule ? schedule.title || t("schedules.untitled") : undefined}
      />
      <header className="page-head">
        <div>
          <h1>{heading}</h1>
          <p className="sub">
            {schedule ? t("schedules.editor.editSubtitle") : t("schedules.editor.createSubtitle")}
          </p>
        </div>
        <div className="actions">
          {notice ? (
            <span className="schedule-notice" data-tone={notice.tone} role="status">
              {notice.text}
            </span>
          ) : null}
          {schedule ? (
            <>
              <Button type="button" size="lg" shape="pill" disabled={hostOffline} onClick={runNow}>
                <Play className="ic ic-sm" aria-hidden="true" />
                {t("settings.schedules.runNow")}
              </Button>
              <Menu.Root>
                <Menu.Trigger
                  render={<Button size="icon-lg" shape="pill" variant="ghost" />}
                  aria-label={fill(t("schedules.more"), {
                    task: schedule.title || t("schedules.untitled"),
                  })}
                >
                  <Ellipsis className="ic ic-sm" aria-hidden="true" />
                </Menu.Trigger>
                <Menu.Portal>
                  <Menu.Positioner side="bottom" align="end" sideOffset={4}>
                    <Menu.Popup className="schedule-menu">
                      {status === "completed" ? null : (
                        <Menu.Item
                          onClick={() =>
                            void onUpdate(schedule.id, { enabled: !schedule.enabled }).catch(
                              (cause: unknown) =>
                                setFailure(
                                  fill(t("schedules.failed"), {
                                    reason: toHostError(cause).message,
                                  }),
                                ),
                            )
                          }
                        >
                          {schedule.enabled ? (
                            <Pause className="ic ic-sm" aria-hidden="true" />
                          ) : (
                            <Play className="ic ic-sm" aria-hidden="true" />
                          )}
                          {schedule.enabled ? t("schedules.pause") : t("schedules.resume")}
                        </Menu.Item>
                      )}
                      {status === "completed" ? null : <Menu.Separator />}
                      <Menu.Item data-danger="" onClick={() => setConfirm("delete")}>
                        <Trash2 className="ic ic-sm" aria-hidden="true" />
                        {t("settings.schedules.delete")}
                      </Menu.Item>
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.Root>
            </>
          ) : null}
        </div>
      </header>
      {schedule ? (
        <div className="schedule-tabs" role="tablist" aria-label={t("schedules.editor.tabs")}>
          {(["settings", "history"] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              className="pill"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
            >
              {t(`schedules.editor.tab.${key}`)}
            </button>
          ))}
        </div>
      ) : null}

      {tab === "history" && schedule ? (
        <ScheduleHistory
          scheduleId={schedule.id}
          revision={historyRevision + localRevision}
          onLoadRuns={onLoadRuns}
          onDeleteRun={onDeleteRun}
          onOpenThread={onOpenThread}
        />
      ) : (
        <div className="schedule-form">
          {hostOffline ? (
            <div className="host-notice-banner" role="status">
              {t("hosts.offlineReadonlyHint")}
            </div>
          ) : null}
          <ScheduleHostField
            isEditing={schedule !== null}
            hosts={hosts}
            targetHostId={targetHostId}
            scheduleHost={scheduleHost}
            hostOffline={hostOffline}
            saving={saving}
            onSelectHost={
              onTargetHostChange
                ? (nextHost) => {
                    setPickedProjectId(null)
                    onTargetHostChange(nextHost)
                  }
                : undefined
            }
          />
          {schedule && status ? (
            <div className="field">
              <span className="label">{t("schedules.field.status")}</span>
              <span className="schedule-status-chip" data-status={status}>
                <StatusDot tone={STATUS_TONES[status]} />
                <span>{t(STATUS_KEYS[status])}</span>
                {status === "active" && schedule.nextRunAt ? (
                  <span className="muted">
                    {fill(t("schedules.nextRun"), {
                      when: formatWhen(schedule.nextRunAt, locale, Date.now()),
                    })}
                  </span>
                ) : null}
                <span className="muted">
                  {fill(t("schedules.runCount"), { count: String(schedule.runCount) })}
                </span>
              </span>
            </div>
          ) : null}
          <label className="field">
            <span className="label">{t("schedules.field.title")}</span>
            <Input
              size="xl"
              value={title}
              maxLength={120}
              disabled={saving || hostOffline}
              placeholder={t("schedules.untitled")}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <div className="field">
            <span className="label">{t("schedules.field.schedule")}</span>
            <ScheduleRuleField
              value={value}
              pinned={pinned}
              disabled={saving || hostOffline}
              onChange={(next) => {
                setRuleValid(next !== null)
                if (next) setValue(next)
              }}
            />
          </div>
          <div className="field">
            <span className="label">{t("schedules.field.prompt")}</span>
            <div role="group" aria-label={t("schedules.execution.label")}>
              <ScheduleComposer
                form={{
                  draft: prompt,
                  onChange: setPrompt,
                  inputLabel: t("schedules.field.prompt"),
                  submitLabel: saving
                    ? schedule
                      ? t("schedules.saving")
                      : t("settings.schedules.creating")
                    : schedule
                      ? t("schedules.save")
                      : t("schedules.createAction"),
                  submitDisabled: !canSave || hostOffline,
                }}
                projects={projects}
                projectId={projectId || null}
                projectLocked={target?.kind === "project"}
                legacy={legacyThreadId ? { id: legacyThreadId, thread: legacyThread } : null}
                onProjectChange={(id) => {
                  setPickedProjectId(id)
                  if (id !== projectId)
                    setExecution((current) => ({ ...current, worktree: undefined }))
                }}
                onAddProject={onAddProject}
                execution={execution}
                onExecutionChange={setExecution}
                agentOptions={agentOptions}
                sources={composerSources}
                saving={saving || hostOffline}
                onSubmit={(text, options) => void submit(text, options)}
              />
            </div>
          </div>
          {failure ? (
            <p className="error-text" role="alert">
              {failure}
            </p>
          ) : null}
        </div>
      )}

      <ScheduleConfirmDialog
        open={confirm === "discard"}
        title={t("schedules.discardTitle")}
        description={t("schedules.discardHint")}
        confirmLabel={t("schedules.discard")}
        onClose={() => setConfirm(null)}
        onConfirm={onBack}
      />
      <ScheduleConfirmDialog
        open={confirm === "delete"}
        title={t("schedules.deleteTitle")}
        description={t("schedules.deleteHint")}
        confirmLabel={t("settings.schedules.delete")}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (!schedule) return
          void onDelete(schedule.id).then(onBack, (cause: unknown) =>
            setFailure(fill(t("schedules.failed"), { reason: toHostError(cause).message })),
          )
        }}
      />
    </div>
  )
}
