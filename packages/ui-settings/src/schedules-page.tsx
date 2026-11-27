/** 定时任务列表、模板与编辑页之间的导航。 */
import { useEffect, useId, useState } from "react"
import {
  Activity,
  Clock,
  FileText,
  ListChecks,
  Plus,
  RotateCw,
  Target,
  type LucideIcon,
} from "lucide-react"
import type { HostSummary, Project, Schedule, ScheduleStatus } from "@pigcode/contracts"
import { Button, Spinner, toHostError, useLocale } from "@pigcode/ui-primitives"
import { KeepAwakeRow } from "./keep-awake-row"
import { ScheduleCard } from "./schedule-card"
import { ScheduleConfirmDialog } from "./schedule-confirm-dialog"
import { ScheduleEditor, type ScheduleDraft } from "./schedule-editor"
import type { ScheduleRunsPage } from "./schedule-history"
import {
  DEFAULT_RULE,
  SCHEDULE_TEMPLATES,
  STATUS_KEYS,
  fill,
  formatRule,
  type ScheduleTemplate,
} from "./schedule-format"
import type {
  CreateScheduleInput,
  RunNowResult,
  ScheduleAgentOptions,
  ScheduleComposerSources,
  ScheduleThreadOption,
  UpdateScheduleInput,
} from "./schedule-types"

export type {
  CreateScheduleInput,
  RunNowResult,
  ScheduleAgentOptions,
  ScheduleComposerSources,
  ScheduleWorkspaceControlsProps,
  ScheduleThreadOption,
  UpdateScheduleInput,
} from "./schedule-types"
export type { ScheduleRunsPage } from "./schedule-history"

/** 定时任务页属性；RPC 由父容器完成，失败时抛错，列表读取失败通过 error 展示。 */
export interface SchedulesPageProps {
  schedules: Schedule[]
  threads: ScheduleThreadOption[]
  projects: readonly Project[]
  preferredProjectId?: string | null | undefined
  hosts?: readonly HostSummary[] | undefined
  targetHostId?: string | undefined
  onTargetHostChange?: ((hostId: string) => void) | undefined
  scheduleHosts?: Readonly<Record<string, HostSummary>> | undefined
  onEditingScheduleChange?: ((schedule: Schedule | null) => void) | undefined
  agentOptions: ScheduleAgentOptions
  composerSources?: ScheduleComposerSources | undefined
  onAddProject?: (() => void) | undefined
  historyRevision?: number | undefined
  loading?: boolean | undefined
  error?: string | null | undefined
  onRefresh?: (() => void) | undefined
  onCreate: (input: CreateScheduleInput) => Promise<unknown>
  onUpdate: (id: string, patch: UpdateScheduleInput) => Promise<unknown>
  onDelete: (id: string) => Promise<unknown>
  onRunNow: (id: string) => Promise<RunNowResult>
  onLoadRuns: (id: string, offset: number, limit: number) => Promise<ScheduleRunsPage>
  onDeleteRun: (runId: string) => Promise<unknown>
  /** 运行历史里「跳到会话」；不传时不显示。 */
  onOpenThread?: ((threadId: string) => void) | undefined
}

type Filter = "all" | ScheduleStatus
const FILTERS: readonly Filter[] = ["all", "active", "paused", "completed"]

const TEMPLATE_ICONS: Record<ScheduleTemplate["id"], LucideIcon> = {
  standup: Target,
  risk: Activity,
  release: FileText,
  docs: ListChecks,
}

const RUN_NOW_KEYS = {
  started: "schedules.runNow.started",
  busy: "schedules.runNow.busy",
  unavailable: "schedules.runNow.unavailable",
  failed: "schedules.runNow.failed",
} as const

/** 列表或编辑页；key 每次打开都不同，编辑页从头开始。 */
type View =
  | { mode: "list" }
  | { mode: "create"; key: number; draft: ScheduleDraft }
  | { mode: "edit"; key: number; id: string }

/** 每分钟刷新一次的当前时间，「下次运行 今天 14:15」跟着走。 */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** 渲染定时任务页。 */
export function SchedulesPage({
  schedules,
  threads,
  projects,
  preferredProjectId,
  hosts,
  targetHostId,
  onTargetHostChange,
  scheduleHosts,
  onEditingScheduleChange,
  agentOptions,
  composerSources,
  onAddProject,
  historyRevision,
  loading = false,
  error = null,
  onRefresh,
  onCreate,
  onUpdate,
  onDelete,
  onRunNow,
  onLoadRuns,
  onDeleteRun,
  onOpenThread,
}: SchedulesPageProps) {
  const { t, locale } = useLocale()
  const now = useMinuteClock()
  const templatesId = useId()
  const [view, setView] = useState<View>({ mode: "list" })
  const [opened, setOpened] = useState(0)
  const [filter, setFilter] = useState<Filter>("all")
  const [deleting, setDeleting] = useState<Schedule | null>(null)
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "warn" } | null>(null)

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 4_000)
    return () => clearTimeout(timer)
  }, [notice])

  function openCreate(draft: ScheduleDraft): void {
    setOpened(opened + 1)
    setView({ mode: "create", key: opened + 1, draft })
  }

  function openEdit(schedule: Schedule): void {
    setOpened(opened + 1)
    setView({ mode: "edit", key: opened + 1, id: schedule.id })
  }

  function runNow(schedule: Schedule): void {
    void onRunNow(schedule.id).then(
      (result) =>
        setNotice({
          text: t(RUN_NOW_KEYS[result.status]),
          tone: result.status === "started" ? "ok" : "warn",
        }),
      () => setNotice({ text: t("schedules.runNow.failed"), tone: "warn" }),
    )
  }

  /** 列表上的操作失败时说明原因；编辑页自己处理它的失败。 */
  function quietly(action: Promise<unknown>): void {
    void action.catch((cause: unknown) =>
      setNotice({
        text: fill(t("schedules.failed"), { reason: toHostError(cause).message }),
        tone: "warn",
      }),
    )
  }

  const editing = view.mode === "edit" ? schedules.find((item) => item.id === view.id) : undefined
  useEffect(() => {
    onEditingScheduleChange?.(editing ?? null)
  }, [editing, onEditingScheduleChange])

  // 编辑的任务在别处被删掉了：回到列表。
  useEffect(() => {
    if (view.mode === "edit" && !loading && !editing) setView({ mode: "list" })
  }, [view.mode, loading, editing])

  const multiHost = Boolean(hosts && hosts.length >= 2)

  if (view.mode !== "list" && (view.mode === "create" || editing)) {
    return (
      <ScheduleEditor
        key={view.key}
        schedule={editing ?? null}
        draft={view.mode === "create" ? view.draft : { title: "", prompt: "", rule: DEFAULT_RULE }}
        threads={threads}
        projects={projects}
        preferredProjectId={preferredProjectId}
        hosts={hosts}
        targetHostId={targetHostId}
        onTargetHostChange={onTargetHostChange}
        scheduleHost={editing ? scheduleHosts?.[editing.id] : undefined}
        agentOptions={agentOptions}
        composerSources={composerSources}
        onAddProject={onAddProject}
        historyRevision={historyRevision}
        onBack={() => setView({ mode: "list" })}
        onCreate={onCreate}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onRunNow={onRunNow}
        onLoadRuns={onLoadRuns}
        onDeleteRun={onDeleteRun}
        onOpenThread={onOpenThread}
      />
    )
  }

  const visible = filter === "all" ? schedules : schedules.filter((item) => item.status === filter)
  const hasSchedules = schedules.length > 0

  return (
    <div className="page wide schedules">
      <header className="page-head">
        <div>
          <h1>{t("settings.schedules.pageTitle")}</h1>
          <p className="sub">
            {t(
              hasSchedules || loading || error
                ? "settings.schedules.subtitle"
                : "settings.schedules.empty",
            )}
          </p>
        </div>
        <div className="actions">
          {notice ? (
            <span className="schedule-notice" data-tone={notice.tone} role="status">
              {notice.text}
            </span>
          ) : null}
          {onRefresh ? (
            <Button
              type="button"
              size="icon-lg"
              shape="pill"
              variant="ghost"
              aria-label={t("schedules.refresh")}
              title={t("schedules.refresh")}
              onClick={onRefresh}
            >
              <RotateCw className="ic ic-sm" aria-hidden="true" />
            </Button>
          ) : null}
          <Button
            size="lg"
            shape="pill"
            variant="primary"
            type="button"
            onClick={() => openCreate({ title: "", prompt: "", rule: DEFAULT_RULE })}
          >
            <Plus className="ic" aria-hidden="true" />
            {t("settings.schedules.new")}
          </Button>
        </div>
      </header>
      {error ? (
        <p className="error-text schedules-error" role="alert">
          {error}
        </p>
      ) : null}

      {hasSchedules ? (
        <>
          <div className="schedules-filter" role="group" aria-label={t("schedules.filter.label")}>
            {FILTERS.map((key) => (
              <button
                key={key}
                type="button"
                className="pill"
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {key === "all" ? t("schedules.filter.all") : t(STATUS_KEYS[key])}
              </button>
            ))}
          </div>
          <div className="schedules-stack">
            <KeepAwakeRow />
            <section className="schedules-mine" aria-label={t("settings.schedules.list")}>
              <h2 className="schedules-section-title">{t("settings.schedules.list")}</h2>
              {visible.length === 0 ? (
                <p className="schedules-filter-empty">{t("schedules.filter.empty")}</p>
              ) : (
                <div className="schedules-grid">
                  {visible.map((schedule) => (
                    <ScheduleCard
                      key={schedule.id}
                      schedule={schedule}
                      host={scheduleHosts?.[schedule.id]}
                      showHost={multiHost}
                      now={now}
                      onEdit={() => openEdit(schedule)}
                      onToggle={() =>
                        quietly(onUpdate(schedule.id, { enabled: !schedule.enabled }))
                      }
                      onRunNow={() => runNow(schedule)}
                      onDelete={() => setDeleting(schedule)}
                    />
                  ))}
                </div>
              )}
            </section>
          </div>
          <hr className="schedules-divider" />
        </>
      ) : loading ? (
        <div className="schedules-loading">
          <Spinner className="ic" aria-label={t("settings.schedules.loading")} />
        </div>
      ) : null}

      <section className="schedules-templates" aria-labelledby={templatesId}>
        <h2 id={templatesId} className="schedules-section-title">
          {t("schedules.templates")}
        </h2>
        <div className="schedules-grid">
          {SCHEDULE_TEMPLATES.map((template) => {
            const Icon = TEMPLATE_ICONS[template.id]
            const descriptionId = `${templatesId}-${template.id}`
            return (
              <button
                key={template.id}
                type="button"
                className="schedule-template"
                aria-label={fill(t("schedules.useTemplate"), { title: t(template.title) })}
                aria-describedby={descriptionId}
                onClick={() =>
                  openCreate({
                    title: t(template.title),
                    prompt: t(template.prompt),
                    rule: template.rule,
                  })
                }
              >
                <span className="schedule-template-title">
                  <span className="schedule-template-icon" data-template={template.id}>
                    <Icon className="ic ic-sm" aria-hidden="true" />
                  </span>
                  {t(template.title)}
                </span>
                <span id={descriptionId} className="schedule-template-desc">
                  {t(template.prompt)}
                </span>
                <span className="schedule-template-when">
                  <Clock className="ic ic-sm" aria-hidden="true" />
                  {formatRule(template.rule, t, locale)}
                </span>
              </button>
            )
          })}
        </div>
      </section>
      {!hasSchedules && !loading ? <KeepAwakeRow /> : null}

      <ScheduleConfirmDialog
        open={deleting !== null}
        title={t("schedules.deleteTitle")}
        description={t("schedules.deleteHint")}
        confirmLabel={t("settings.schedules.delete")}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) quietly(onDelete(deleting.id))
        }}
      />
    </div>
  )
}
