/**
 * 验证定时任务页：卡片与状态筛选、新建与编辑页（常用频率、自定义重复、模板预填、未保存提醒）、
 * 卡片菜单里的立即运行、暂停与删除、运行历史与翻页、保持唤醒开关，以及规则怎么说。
 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  DEFAULT_RUNTIME_MODE,
  type Schedule,
  type ScheduleRule,
  type ScheduleRun,
} from "@pigcode/contracts"
import { LocaleProvider, translate, type MessageKey } from "@pigcode/ui-primitives"
import { formatRule, weekdayName } from "./schedule-format"
import { SchedulesPage, type SchedulesPageProps } from "./schedules-page"

/** 一条每天 09:00 运行、12 分钟后运行的任务。 */
function scheduleFixture(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "sch_1",
    target: { kind: "thread", threadId: "th_1" },
    title: "每日汇总",
    prompt: "把今天的改动整理成清单",
    draft: null,
    rule: { kind: "daily", time: "09:00" },
    endsAt: null,
    enabled: true,
    status: "active",
    nextRunAt: new Date(Date.now() + 12 * 60_000).toISOString(),
    lastRunAt: null,
    lastRunId: null,
    runCount: 3,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    ...overrides,
  }
}

function runFixture(overrides: Partial<ScheduleRun> = {}): ScheduleRun {
  return {
    id: "srun_1",
    scheduleId: "sch_1",
    source: "schedule",
    status: "succeeded",
    threadId: "th_1",
    runId: "run_1",
    error: null,
    triggeredAt: "2026-11-06T01:00:00.000Z",
    finishedAt: "2026-11-06T01:01:35.000Z",
    ...overrides,
  }
}

/** 渲染带 locale 的页面。 */
function renderPage(overrides: Partial<SchedulesPageProps> = {}) {
  const props: SchedulesPageProps = {
    schedules: [scheduleFixture()],
    threads: [
      { id: "th_1", title: "Sprint" },
      { id: "th_2", title: "Release" },
    ],
    projects: [
      { id: "pr_1", name: "Sprint", rootPath: "/sprint", createdAt: "2026-10-20T00:00:00.000Z" },
      { id: "pr_2", name: "Release", rootPath: "/release", createdAt: "2026-10-20T00:00:00.000Z" },
    ],
    agentOptions: { agents: [], catalog: {} },
    onCreate: vi.fn().mockResolvedValue(undefined),
    onUpdate: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn().mockResolvedValue(undefined),
    onRunNow: vi.fn().mockResolvedValue({ status: "started", runId: "run_9" }),
    onLoadRuns: vi.fn().mockResolvedValue({ runs: [], total: 0 }),
    onDeleteRun: vi.fn().mockResolvedValue(undefined),
    onOpenThread: vi.fn(),
    ...overrides,
  }
  render(
    <LocaleProvider locale="zh-CN">
      <SchedulesPage {...props} />
    </LocaleProvider>,
  )
  return props
}

/** 选中一个下拉框里的选项。 */
async function choose(name: string, option: string): Promise<void> {
  await userEvent.click(screen.getByRole("combobox", { name }))
  await userEvent.click(await screen.findByRole("option", { name: option }))
}

/** 打开新建页，写好指令。 */
async function openCreate(prompt = "巡检"): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: "新建任务" }))
  await screen.findByRole("heading", { name: "新建任务" })
  if (prompt) await userEvent.type(screen.getByLabelText("要做什么"), prompt)
}

/** 卡片右上角的菜单。 */
async function openMenu(task = "每日汇总"): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: `${task} 的更多操作` }))
}

const saveButton = (name = "创建任务") => screen.getByRole("button", { name }) as HTMLButtonElement
const longDay = (day: number) => weekdayName(day, "zh-CN", "long")

/** 在今天所在的星期上依次切换几天，得到排好序的结果；每周默认选中今天。 */
function daysAfter(toggles: number[]): number[] {
  const days = new Set([new Date().getDay()])
  for (const day of toggles) {
    if (days.has(day)) days.delete(day)
    else days.add(day)
  }
  return [...days].sort()
}

afterEach(() => {
  cleanup()
  delete (globalThis as { pigcodeNative?: unknown }).pigcodeNative
})

describe("SchedulesPage list", () => {
  it("shows the title, instruction, schedule with the next run, and run count on each card", () => {
    renderPage()
    const card = screen.getByRole("button", { name: "每日汇总" }).closest("article")!
    const text = card.textContent ?? ""
    expect(text).toContain("把今天的改动整理成清单")
    expect(text).toMatch(/每天 09:00 · 下次 (今天|明天) \d{2}:\d{2}/)
    expect(text).toContain("跑了 3 次")
  })

  it("falls back to a placeholder title and shows paused and completed states without a next run", () => {
    renderPage({
      schedules: [
        scheduleFixture({ id: "a", title: "", status: "paused", enabled: false }),
        scheduleFixture({ id: "b", title: "发版", status: "completed", nextRunAt: null }),
      ],
    })
    const paused = screen.getByRole("button", { name: "没有名字的任务" }).closest("article")!
    expect(paused.textContent).toContain("已暂停")
    expect(paused.textContent).not.toContain("下次运行")
    const done = screen.getByRole("button", { name: "发版" }).closest("article")!
    expect(done.getAttribute("data-status")).toBe("completed")
    expect(done.textContent).toContain("已结束")
  })

  it("filters cards by status", async () => {
    renderPage({
      schedules: [
        scheduleFixture({ id: "a", title: "早报" }),
        scheduleFixture({ id: "b", title: "周报", status: "paused", enabled: false }),
      ],
    })
    await userEvent.click(screen.getByRole("button", { name: "已暂停" }))
    expect(screen.queryByRole("button", { name: "早报" })).toBeNull()
    expect(screen.getByRole("button", { name: "周报" })).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "已结束" }))
    expect(screen.getByText("没有这样的任务")).toBeTruthy()
  })

  it("offers one create action, templates and the wake preference on the empty page", () => {
    renderPage({ schedules: [], threads: [] })
    expect(screen.getByText("还没有定时任务")).toBeTruthy()
    expect(screen.getByRole("button", { name: "新建任务" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "从模板开始" })).toBeTruthy()
    expect(screen.getByRole("switch", { name: "不让电脑睡着" })).toBeTruthy()
    expect(screen.queryByRole("group", { name: "按状态筛选" })).toBeNull()
  })

  it("runs a task now from the card menu and says when the thread was busy", async () => {
    const onRunNow = vi.fn().mockResolvedValue({ status: "busy", runId: null })
    renderPage({ onRunNow })
    await openMenu()
    await userEvent.click(await screen.findByRole("menuitem", { name: "现在运行" }))
    expect(onRunNow).toHaveBeenCalledWith("sch_1")
    expect((await screen.findByRole("status")).textContent).toBe("上一次还没跑完，等会再试")
  })

  it("pauses and resumes from the menu, and offers neither for a completed task", async () => {
    const props = renderPage({
      schedules: [
        scheduleFixture(),
        scheduleFixture({ id: "b", title: "发版", status: "completed", nextRunAt: null }),
      ],
    })
    await openMenu()
    await userEvent.click(await screen.findByRole("menuitem", { name: "暂停" }))
    expect(props.onUpdate).toHaveBeenCalledWith("sch_1", { enabled: false })

    await openMenu("发版")
    await screen.findByRole("menuitem", { name: "现在运行" })
    expect(screen.queryByRole("menuitem", { name: "暂停" })).toBeNull()
    expect(screen.queryByRole("menuitem", { name: "恢复" })).toBeNull()
  })

  it("deletes only after confirming", async () => {
    const props = renderPage()
    await openMenu()
    await userEvent.click(await screen.findByRole("menuitem", { name: "删除" }))
    const dialog = await screen.findByRole("dialog", { name: "删除这个任务？" })
    expect(props.onDelete).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole("button", { name: "删除" }))
    expect(props.onDelete).toHaveBeenCalledWith("sch_1")
  })

  it("keeps the computer awake through the shared preference", async () => {
    const setPreference = vi.fn().mockResolvedValue({ keepAwake: true })
    ;(globalThis as { pigcodeNative?: unknown }).pigcodeNative = {
      getPreferences: vi.fn().mockResolvedValue({ keepAwake: false }),
      setPreference,
    }
    renderPage()
    await userEvent.click(screen.getByRole("switch", { name: "不让电脑睡着" }))
    expect(setPreference).toHaveBeenCalledWith("keepAwake", true)
  })
})

describe("SchedulesPage editor", () => {
  it("creates a task that runs every day at nine by default and returns to the list", async () => {
    const props = renderPage({ threads: [] })
    await openCreate("发版检查")
    expect(screen.getByText(/^下次：/)).toBeTruthy()
    await userEvent.click(saveButton())
    expect(props.onCreate).toHaveBeenCalledWith({
      projectId: "pr_1",
      execution: { permissionMode: DEFAULT_RUNTIME_MODE },
      title: "",
      prompt: "发版检查",
      draft: { document: expect.any(String) },
      rule: { kind: "daily", time: "09:00" },
      endsAt: null,
      enabled: true,
    })
    expect(await screen.findByRole("heading", { name: "定时任务" })).toBeTruthy()
  })

  it("needs an instruction before creating", async () => {
    renderPage()
    await openCreate("")
    expect(saveButton().disabled).toBe(true)
  })

  it("offers to add a project when there are none", async () => {
    const onAddProject = vi.fn()
    renderPage({ projects: [], onAddProject })
    await openCreate()
    expect(saveButton().disabled).toBe(true)
    await userEvent.click(screen.getByRole("button", { name: "添加项目" }))
    expect(onAddProject).toHaveBeenCalledTimes(1)
  })

  // 要依次打开四个下拉（分钟有 60 项），整套测试并行跑时给它多留一点时间。
  it(
    "creates a weekly task on the picked days and time, for the picked project",
    { timeout: 15_000 },
    async () => {
      const props = renderPage()
      await openCreate()
      fireEvent.change(screen.getByLabelText("名字"), { target: { value: "周会" } })
      await userEvent.click(
        within(screen.getByRole("group", { name: "运行设置" })).getByRole("button", {
          name: /Sprint/,
        }),
      )
      await userEvent.click(await screen.findByRole("menuitem", { name: /^Release/ }))
      await choose("多久一次", "每周")
      await userEvent.click(screen.getByRole("button", { name: "星期几" }))
      await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: longDay(1) }))
      await userEvent.click(screen.getByRole("menuitemcheckbox", { name: longDay(5) }))
      await choose("几点", "16")
      await choose("几分", "30")
      await userEvent.click(saveButton())
      expect(props.onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "pr_2",
          title: "周会",
          rule: { kind: "weekly", days: daysAfter([1, 5]), time: "16:30" },
        }),
      )
    },
  )

  it("needs at least one day for a weekly task", async () => {
    renderPage()
    await openCreate()
    await choose("多久一次", "每周")
    await userEvent.click(screen.getByRole("button", { name: "星期几" }))
    await userEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: longDay(new Date().getDay()) }),
    )
    expect(screen.getByText("至少选一天")).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
  })

  it("creates a custom repeat every two weeks that ends on a date", async () => {
    // 自定义重复默认选中今天；先点掉它再选另一个星期几，否则测试在星期四会只剩空选择。
    const today = new Date().getDay()
    const day = (today + 1) % 7
    const props = renderPage()
    await openCreate()
    await choose("多久一次", "自定义")
    const dialog = await screen.findByRole("dialog", { name: "自定义重复" })
    fireEvent.change(within(dialog).getByLabelText("间隔"), { target: { value: "2" } })
    await choose("单位", "周")
    await userEvent.click(within(dialog).getByRole("button", { name: longDay(today) }))
    await userEvent.click(within(dialog).getByRole("button", { name: longDay(day) }))
    await userEvent.click(within(dialog).getByRole("radio", { name: "到某天结束" }))
    fireEvent.change(within(dialog).getByLabelText("结束日期"), { target: { value: "2026-12-31" } })
    await userEvent.click(within(dialog).getByRole("button", { name: "确定" }))

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "自定义重复" })).toBeNull())
    expect(screen.getByRole("button", { name: "改重复规则" }).textContent).toMatch(/^每 2 周的/)
    await userEvent.click(saveButton())
    expect(props.onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        rule: {
          kind: "everyWeeks",
          every: 2,
          days: daysAfter([today, day]),
          time: "09:00",
          anchor: expect.any(String),
        },
        endsAt: new Date(2026, 11, 31, 23, 59, 59, 999).toISOString(),
      }),
    )
  }, 15_000)

  it("rejects a custom interval outside 1 to 200", async () => {
    renderPage()
    await openCreate()
    await choose("多久一次", "自定义")
    const dialog = await screen.findByRole("dialog", { name: "自定义重复" })
    fireEvent.change(within(dialog).getByLabelText("间隔"), { target: { value: "0" } })
    expect(within(dialog).getByText("填 1 到 200 的整数")).toBeTruthy()
    expect(
      (within(dialog).getByRole("button", { name: "确定" }) as HTMLButtonElement).disabled,
    ).toBe(true)
  }, 15_000)

  it("prefills the editor from a template", async () => {
    const props = renderPage()
    await userEvent.click(screen.getByRole("button", { name: "用「每日总结」新建" }))
    expect((screen.getByLabelText("名字") as HTMLInputElement).value).toBe("每日总结")
    await userEvent.click(saveButton())
    expect(props.onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "每日总结",
        prompt: translate("zh-CN", "schedules.template.standup.prompt" as MessageKey),
        rule: { kind: "weekdays", time: "09:00" },
      }),
    )
  })

  it("edits a task, sending only what changed", async () => {
    const props = renderPage()
    await userEvent.click(screen.getByRole("button", { name: "每日汇总" }))
    await screen.findByRole("heading", { name: "编辑任务" })
    expect(screen.getByText("用的会话 · Sprint")).toBeTruthy()
    expect(saveButton("保存").disabled).toBe(true)
    await userEvent.clear(screen.getByLabelText("名字"))
    await userEvent.type(screen.getByLabelText("名字"), "晚间汇总")
    await userEvent.click(saveButton("保存"))
    expect(props.onUpdate).toHaveBeenCalledWith("sch_1", { title: "晚间汇总" })
  })

  it("asks before leaving with unsaved changes", async () => {
    renderPage()
    await userEvent.click(screen.getByRole("button", { name: "每日汇总" }))
    await userEvent.type(screen.getByLabelText("要做什么"), "，再加上风险")
    await userEvent.click(screen.getByRole("button", { name: "返回定时任务" }))
    const dialog = await screen.findByRole("dialog", { name: "不保存就离开？" })
    await userEvent.click(within(dialog).getByRole("button", { name: "不保存" }))
    expect(await screen.findByRole("heading", { name: "定时任务" })).toBeTruthy()
  })

  it("lists run history with reasons, opens the thread, deletes a record and pages through", async () => {
    const onLoadRuns = vi.fn().mockResolvedValue({
      runs: [
        runFixture(),
        runFixture({
          id: "srun_2",
          source: "manual",
          status: "skipped",
          threadId: null,
          runId: null,
          error: "THREAD_BUSY",
          finishedAt: null,
        }),
      ],
      total: 45,
    })
    const props = renderPage({ onLoadRuns })
    await userEvent.click(screen.getByRole("button", { name: "每日汇总" }))
    await userEvent.click(screen.getByRole("tab", { name: "运行记录" }))

    const rows = await screen.findAllByRole("row")
    expect(rows[1]!.textContent).toContain("成功")
    expect(rows[2]!.textContent).toContain("手动")
    expect(rows[2]!.textContent).toContain("已跳过")
    expect(rows[2]!.textContent).toContain("会话在忙")
    expect(within(rows[2]!).queryByRole("button", { name: "打开会话" })).toBeNull()

    await userEvent.click(within(rows[1]!).getByRole("button", { name: "打开会话" }))
    expect(props.onOpenThread).toHaveBeenCalledWith("th_1")

    await userEvent.click(within(rows[2]!).getByRole("button", { name: "删除记录" }))
    expect(props.onDeleteRun).toHaveBeenCalledWith("srun_2")
    await waitFor(() => expect(onLoadRuns).toHaveBeenCalledTimes(2))

    expect(screen.getByText("第 1 / 3 页")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "下一页" }))
    await waitFor(() => expect(onLoadRuns).toHaveBeenLastCalledWith("sch_1", 20, 20))
  })
})

describe("formatRule", () => {
  const say = (rule: ScheduleRule) => formatRule(rule, (key) => translate("zh-CN", key), "zh-CN")
  const anchor = "2026-11-02T01:00:00.000Z"

  it("describes every kind of rule", () => {
    expect(say({ kind: "hourly", minute: 5 })).toBe("每小时的第 05 分")
    expect(say({ kind: "weekdays", time: "09:00" })).toBe("工作日 09:00")
    expect(say({ kind: "weekly", days: [5, 1], time: "16:00" })).toBe("每周一、周五 16:00")
    expect(say({ kind: "monthly", day: 15, time: "10:00" })).toBe("每月 15 号 10:00")
    expect(say({ kind: "everyMinutes", every: 30, anchor })).toBe("每 30 分钟")
    expect(say({ kind: "everyHours", every: 2, minute: 15, anchor })).toBe("每 2 小时的第 15 分")
    expect(say({ kind: "everyDays", every: 3, time: "08:00", anchor })).toBe("每 3 天 08:00")
    expect(say({ kind: "everyWeeks", every: 2, days: [1, 4], time: "10:00", anchor })).toBe(
      "每 2 周的周一、周四，10:00",
    )
    expect(say({ kind: "everyMonths", every: 1, days: [1, 15], time: "09:00", anchor })).toBe(
      "每 1 个月的 1、15 号，09:00",
    )
    expect(say({ kind: "everyMonthsWeekday", every: 2, weekday: 1, time: "09:00", anchor })).toBe(
      "每 2 个月的第一个周一，09:00",
    )
    expect(say({ kind: "everyYears", every: 1, month: 3, day: 8, time: "09:00", anchor })).toBe(
      "每 1 年的3月8日，09:00",
    )
  })
})
