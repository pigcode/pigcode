/**
 * 定时任务页：列表与编辑页两种样子。列表上面是状态筛选和「保持电脑唤醒」，已创建的任务排成两列卡片，
 * 卡片上是标题、指令、计划与下一次运行、运行次数；整张卡片点开就是编辑页，更多操作在右上角的菜单里。
 * 下面隔一条线是模板，点开后预填到新建页里。
 */
import { useEffect, useId, useState } from "react"
import {
  Activity,
  CircleCheck,
  Clock,
  Ellipsis,
  FileText,
  Info,
  ListChecks,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Target,
  Trash2,
  type LucideIcon,
} from "lucide-react"
import type { Schedule, ScheduleStatus } from "@pigcode/contracts"
import { Button, Menu, Spinner, Switch, toHostError, useLocale } from "@pigcode/ui-primitives"
import { usePreferences } from "./preferences"
import { ConfirmDialog, ScheduleEditor, type ScheduleDraft } from "./schedule-editor"
import type { ScheduleRunsPage } from "./schedule-history"
import {
  DEFAULT_RULE,
  SCHEDULE_TEMPLATES,
  STATUS_KEYS,
  fill,
  formatRule,
  formatWhen,
  type ScheduleTemplate,
} from "./schedule-format"
import type {
  CreateScheduleInput,
  RunNowResult,
  ScheduleThreadOption,
  UpdateScheduleInput,
} from "./schedule-types"

export type {
  CreateScheduleInput,
  RunNowResult,
  ScheduleThreadOption,
  UpdateScheduleInput,
} from "./schedule-types"
export type { ScheduleRunsPage } from "./schedule-history"

/** 定时任务页属性；RPC 由父容器完成，失败时抛错，列表读取失败通过 error 展示。 */
export interface SchedulesPageProps {
  schedules: Schedule[]
  threads: ScheduleThreadOption[]
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

const STATUS_ICONS: Record<ScheduleStatus, LucideIcon> = {
  active: Clock,
  paused: Pause,
  completed: CircleCheck,
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

/** 读屏与菜单里用的任务名：标题，没有标题时是指令的第一行。 */
function taskName(schedule: Schedule, untitled: string): string {
  if (schedule.title) return schedule.title
  const line = schedule.prompt.trim().split(/\r?\n/)[0] ?? ""
  return line ? (line.length > 40 ? `${line.slice(0, 40)}…` : line) : untitled
}

function ScheduleCard({
  schedule,
  now,
  onEdit,
  onToggle,
  onRunNow,
  onDelete,
}: {
  schedule: Schedule
  now: number
  onEdit: () => void
  onToggle: () => void
  onRunNow: () => void
  onDelete: () => void
}) {
  const { t, locale } = useLocale()
  const [menuOpen, setMenuOpen] = useState(false)
  const name = taskName(schedule, t("schedules.untitled"))
  const { status } = schedule
  const StatusIcon = STATUS_ICONS[status]
  const rule = formatRule(schedule.rule, t, locale)
  // 暂停与完成后不再往下排，只说计划本身；运行中的任务接着说下一次。
  const when =
    status === "active" && schedule.nextRunAt
      ? `${rule} · ${fill(t("schedules.nextRun"), { when: formatWhen(schedule.nextRunAt, locale, now) })}`
      : rule
  return (
    <article
      className="schedule-card"
      data-schedule={schedule.id}
      data-status={status}
      data-menu-open={menuOpen ? "" : undefined}
    >
      <button type="button" className="schedule-card-main" onClick={onEdit}>
        <span className="schedule-card-title truncate">
          {schedule.title || t("schedules.untitled")}
        </span>
      </button>
      <p className="schedule-card-prompt">{schedule.prompt}</p>
      <div className="schedule-card-foot">
        {status === "active" ? null : (
          <span className="schedule-card-state">
            <StatusIcon className="ic ic-sm" aria-hidden="true" />
            {t(STATUS_KEYS[status])}
          </span>
        )}
        <span
          className="schedule-card-when"
          data-dim={status === "active" ? undefined : ""}
          title={when}
        >
          <Clock className="ic ic-sm" aria-hidden="true" />
          <span className="truncate">{when}</span>
        </span>
        <span className="schedule-card-count">
          {fill(t("schedules.runCount"), { count: String(schedule.runCount) })}
        </span>
      </div>
      <Menu.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <Menu.Trigger
          className="icon-btn schedule-card-menu"
          aria-label={fill(t("schedules.more"), { task: name })}
          title={fill(t("schedules.more"), { task: name })}
        >
          <Ellipsis className="ic ic-sm" aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={4}>
            <Menu.Popup className="schedule-menu">
              <Menu.Item onClick={onRunNow}>
                <Play className="ic ic-sm" aria-hidden="true" />
                {t("settings.schedules.runNow")}
              </Menu.Item>
              <Menu.Item onClick={onEdit}>
                <Pencil className="ic ic-sm" aria-hidden="true" />
                {t("schedules.edit")}
              </Menu.Item>
              {status === "completed" ? null : (
                <Menu.Item onClick={onToggle}>
                  {schedule.enabled ? (
                    <Pause className="ic ic-sm" aria-hidden="true" />
                  ) : (
                    <Play className="ic ic-sm" aria-hidden="true" />
                  )}
                  {schedule.enabled ? t("schedules.pause") : t("schedules.resume")}
                </Menu.Item>
              )}
              <Menu.Separator />
              <Menu.Item data-danger="" onClick={onDelete}>
                <Trash2 className="ic ic-sm" aria-hidden="true" />
                {t("settings.schedules.delete")}
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </article>
  )
}

/** 「保持电脑唤醒」：和通用设置里的同一个开关。 */
function KeepAwakeBar() {
  const { t } = useLocale()
  const [prefs, setPreference] = usePreferences()
  return (
    <div className="schedules-awake">
      <Info className="ic ic-sm" aria-hidden="true" />
      <p>
        <span className="schedules-awake-title">{t("schedules.keepAwake.title")}</span>
        <span className="schedules-awake-hint">{t("schedules.keepAwake.hint")}</span>
      </p>
      <Switch
        aria-label={t("schedules.keepAwake.title")}
        checked={prefs.keepAwake}
        onCheckedChange={(checked) => setPreference("keepAwake", checked)}
      />
    </div>
  )
}

/** 渲染定时任务页。 */
export function SchedulesPage({
  schedules,
  threads,
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
  // 编辑的任务在别处被删掉了：回到列表。
  useEffect(() => {
    if (view.mode === "edit" && !loading && !editing) setView({ mode: "list" })
  }, [view.mode, loading, editing])

  if (view.mode !== "list" && (view.mode === "create" || editing)) {
    return (
      <ScheduleEditor
        key={view.key}
        schedule={editing ?? null}
        draft={view.mode === "create" ? view.draft : { title: "", prompt: "", rule: DEFAULT_RULE }}
        threads={threads}
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
  const createButton = (
    <Button
      size="sm"
      variant="primary"
      type="button"
      onClick={() => openCreate({ title: "", prompt: "", rule: DEFAULT_RULE })}
    >
      <Plus className="ic ic-sm" aria-hidden="true" />
      {t("settings.schedules.new")}
    </Button>
  )

  return (
    <div className="page wide schedules">
      <header className="page-head">
        <div>
          <h1>{t("settings.schedules.pageTitle")}</h1>
          <p className="sub">{t("settings.schedules.subtitle")}</p>
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
              size="icon"
              variant="ghost"
              aria-label={t("schedules.refresh")}
              title={t("schedules.refresh")}
              onClick={onRefresh}
            >
              <RotateCw className="ic ic-sm" aria-hidden="true" />
            </Button>
          ) : null}
          {createButton}
        </div>
      </header>
      {error ? (
        <p className="error-text schedules-error" role="alert">
          {error}
        </p>
      ) : null}

      {schedules.length > 0 ? (
        <div className="schedules-filter" role="group" aria-label={t("schedules.filter.label")}>
          {FILTERS.map((key) => (
            <button
              key={key}
              type="button"
              className="schedules-filter-pill"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {key === "all" ? t("schedules.filter.all") : t(STATUS_KEYS[key])}
            </button>
          ))}
        </div>
      ) : null}

      <div className="schedules-stack">
        {schedules.length > 0 ? <KeepAwakeBar /> : null}
        {schedules.length === 0 && loading ? (
          <div className="schedules-loading">
            <Spinner className="ic" aria-label={t("settings.schedules.loading")} />
          </div>
        ) : schedules.length === 0 ? (
          <div className="schedules-empty">
            <p className="schedules-empty-title">{t("settings.schedules.empty")}</p>
            <p className="schedules-empty-hint">
              {threads.length === 0
                ? t("settings.schedules.noThreads")
                : t("settings.schedules.emptyHint")}
            </p>
            {createButton}
          </div>
        ) : (
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
                    now={now}
                    onEdit={() => openEdit(schedule)}
                    onToggle={() => quietly(onUpdate(schedule.id, { enabled: !schedule.enabled }))}
                    onRunNow={() => runNow(schedule)}
                    onDelete={() => setDeleting(schedule)}
                  />
                ))}
              </div>
            )}
          </section>
        )}
        {schedules.length === 0 && !loading ? <KeepAwakeBar /> : null}
      </div>

      <hr className="schedules-divider" />

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

      <ConfirmDialog
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
