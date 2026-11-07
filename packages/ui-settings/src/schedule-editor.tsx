/**
 * 定时任务的编辑页：新建与编辑都在这一页。上面是返回定时任务的面包屑、标题和一条操作栏（编辑时左边是
 * 「设置 / 历史」页签，右边是保存、立即运行和更多操作），下面是表单或运行历史。
 * 有没保存的修改时离开要先确认；保存成功后回到列表。
 */
import { useEffect, useId, useState, type FormEvent } from "react"
import { ChevronLeft, Ellipsis, Pause, Play, Trash2 } from "lucide-react"
import type { Schedule, ScheduleRule, ScheduleStatus } from "@pigcode/contracts"
import {
  Button,
  Dialog,
  Input,
  Menu,
  StatusDot,
  Textarea,
  toHostError,
  useLocale,
  type StatusTone,
} from "@pigcode/ui-primitives"
import { ChoiceSelect } from "./choice-select"
import { ScheduleHistory, type ScheduleRunsPage } from "./schedule-history"
import { STATUS_KEYS, fill, formatWhen } from "./schedule-format"
import { ScheduleRuleField, type RuleValue } from "./schedule-rule-field"
import type {
  CreateScheduleInput,
  RunNowResult,
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

/** 确认对话框：删除任务、放弃修改都用它。 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  onClose: () => void
  onConfirm: () => void
}) {
  const { t } = useLocale()
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <Dialog.Content
        className="schedule-confirm"
        title={title}
        description={description}
        closeLabel={t("common.close")}
      >
        <Dialog.Footer>
          <Dialog.Close render={<Button type="button" variant="ghost" />}>
            {t("schedules.cancel")}
          </Dialog.Close>
          <Button
            type="button"
            variant="solidDanger"
            onClick={() => {
              onClose()
              onConfirm()
            }}
          >
            {confirmLabel}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  )
}

/** 表单里可以比较的字段；和打开时不一样就是有没保存的修改。 */
function signature(fields: {
  title: string
  threadId: string
  prompt: string
  value: RuleValue
}): string {
  return JSON.stringify([
    fields.title.trim(),
    fields.threadId,
    fields.prompt.trim(),
    fields.value.rule,
    fields.value.endsAt,
  ])
}

export function ScheduleEditor({
  schedule,
  draft,
  threads,
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
  const formId = useId()
  const [initial] = useState(() => ({
    title: schedule?.title ?? draft.title,
    threadId: schedule?.threadId ?? threads[0]?.id ?? "",
    prompt: schedule?.prompt ?? draft.prompt,
    value: { rule: schedule?.rule ?? draft.rule, endsAt: schedule?.endsAt ?? null },
  }))
  const [tab, setTab] = useState<"settings" | "history">("settings")
  const [title, setTitle] = useState(initial.title)
  const [threadId, setThreadId] = useState(initial.threadId)
  const [prompt, setPrompt] = useState(initial.prompt)
  const [value, setValue] = useState<RuleValue>(initial.value)
  const [ruleValid, setRuleValid] = useState(true)
  const [promptTouched, setPromptTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "warn" } | null>(null)
  const [confirm, setConfirm] = useState<"discard" | "delete" | null>(null)
  const [historyVersion, setHistoryVersion] = useState(0)

  // 会话列表晚于页面加载、或者选中的会话被删掉时，新建任务改选第一个会话。
  useEffect(() => {
    if (schedule || threads.some((thread) => thread.id === threadId)) return
    setThreadId(threads[0]?.id ?? "")
  }, [schedule, threadId, threads])

  // 立即运行的结果显示几秒后自己消失。
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 4_000)
    return () => clearTimeout(timer)
  }, [notice])

  const trimmed = prompt.trim()
  const dirty = signature({ title, threadId, prompt, value }) !== signature(initial)
  const canSave =
    !saving && ruleValid && trimmed !== "" && threadId !== "" && (schedule === null || dirty)
  const ruleUnchanged =
    schedule !== null &&
    JSON.stringify([value.rule, value.endsAt]) === JSON.stringify([schedule.rule, schedule.endsAt])
  const pinned = ruleUnchanged && schedule?.status === "active" ? schedule.nextRunAt : undefined

  function requestBack(): void {
    if (dirty && !saving) setConfirm("discard")
    else onBack()
  }

  async function submit(event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault()
    setPromptTouched(true)
    if (!canSave) return
    setSaving(true)
    setFailure(null)
    try {
      if (schedule) {
        const patch: UpdateScheduleInput = {}
        if (title.trim() !== schedule.title) patch.title = title.trim()
        if (trimmed !== schedule.prompt) patch.prompt = trimmed
        if (!ruleUnchanged) {
          patch.rule = value.rule
          patch.endsAt = value.endsAt
        }
        await onUpdate(schedule.id, patch)
      } else {
        await onCreate({
          threadId,
          title: title.trim(),
          prompt: trimmed,
          rule: value.rule,
          endsAt: value.endsAt,
          enabled: true,
        })
      }
      onBack()
    } catch (cause) {
      setFailure(fill(t("schedules.failed"), { reason: toHostError(cause).message }))
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
        setHistoryVersion((current) => current + 1)
      },
      () => setNotice({ text: t("schedules.runNow.failed"), tone: "warn" }),
    )
  }

  // 编辑的任务指向的会话被删掉时，选择器里仍然显示一项「会话已删除」。
  const threadOptions = threads.map((thread) => ({ value: thread.id, label: thread.title }))
  if (threadId !== "" && !threads.some((thread) => thread.id === threadId)) {
    threadOptions.unshift({ value: threadId, label: t("schedules.threadMissing") })
  }
  const heading = schedule ? t("schedules.editor.editTitle") : t("schedules.editor.createTitle")
  const status = schedule?.status
  return (
    <div className="page wide schedule-editor">
      <nav className="schedule-crumbs" aria-label={t("schedules.editor.backLabel")}>
        <button type="button" className="schedule-back" onClick={requestBack}>
          <ChevronLeft className="ic ic-sm" aria-hidden="true" />
          {t("schedules.editor.back")}
        </button>
        <span className="schedule-crumb-sep" aria-hidden="true">
          /
        </span>
        <span className="schedule-crumb-current truncate" aria-current="page">
          {schedule ? schedule.title || t("schedules.untitled") : t("schedules.editor.createTitle")}
        </span>
      </nav>
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
              <Button type="button" size="sm" onClick={runNow}>
                <Play className="ic ic-sm" aria-hidden="true" />
                {t("settings.schedules.runNow")}
              </Button>
              <Menu.Root>
                <Menu.Trigger
                  className="btn btn-secondary btn-sm btn-icon"
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
          {tab === "settings" ? (
            <Button type="submit" form={formId} size="sm" variant="primary" disabled={!canSave}>
              {saving
                ? schedule
                  ? t("schedules.saving")
                  : t("settings.schedules.creating")
                : schedule
                  ? t("schedules.save")
                  : t("schedules.createAction")}
            </Button>
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
              className="schedule-tab"
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
          key={historyVersion}
          scheduleId={schedule.id}
          onLoadRuns={onLoadRuns}
          onDeleteRun={onDeleteRun}
          onOpenThread={onOpenThread}
        />
      ) : (
        <form id={formId} className="schedule-form" onSubmit={(event) => void submit(event)}>
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
              value={title}
              maxLength={120}
              disabled={saving}
              placeholder={t("schedules.untitled")}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <div className="field">
            <span className="label">{t("schedules.field.thread")}</span>
            {threads.length === 0 && !schedule ? (
              <p className="schedule-form-notice">{t("settings.schedules.noThreads")}</p>
            ) : (
              <ChoiceSelect
                label={t("schedules.field.thread")}
                value={threadId}
                options={threadOptions}
                disabled={schedule !== null || saving}
                onChange={setThreadId}
              />
            )}
            {schedule ? <span className="hint">{t("schedules.threadLocked")}</span> : null}
          </div>
          <div className="field">
            <span className="label">{t("schedules.field.schedule")}</span>
            <ScheduleRuleField
              value={value}
              pinned={pinned}
              disabled={saving}
              onChange={(next) => {
                setRuleValid(next !== null)
                if (next) setValue(next)
              }}
            />
          </div>
          <label className="field">
            <span className="label">{t("schedules.field.prompt")}</span>
            <Textarea
              value={prompt}
              rows={7}
              disabled={saving}
              aria-invalid={promptTouched && trimmed === "" ? true : undefined}
              placeholder={t("settings.schedules.promptPlaceholder")}
              onChange={(event) => setPrompt(event.target.value)}
              onBlur={() => setPromptTouched(true)}
            />
            {promptTouched && trimmed === "" ? (
              <span className="error-text">{t("schedules.promptRequired")}</span>
            ) : null}
          </label>
          {failure ? (
            <p className="error-text" role="alert">
              {failure}
            </p>
          ) : null}
        </form>
      )}

      <ConfirmDialog
        open={confirm === "discard"}
        title={t("schedules.discardTitle")}
        description={t("schedules.discardHint")}
        confirmLabel={t("schedules.discard")}
        onClose={() => setConfirm(null)}
        onConfirm={onBack}
      />
      <ConfirmDialog
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
