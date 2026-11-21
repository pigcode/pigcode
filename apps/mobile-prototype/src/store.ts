/**
 * 原型的内存状态：每个会话的事件、计划、正在输出的文字、排队的消息和草稿。
 * 「运行中」的会话按脚本一步步追加事件；连接不在线时脚本停住，连上再接着走。
 */
import { useSyncExternalStore } from "react"
import type { ThreadEvent } from "@pigcode/contracts"
import type { ApprovalDecision, QuestionView } from "@pigcode/ui-chat"
import {
  changedFiles,
  event,
  INITIAL_META,
  initialEvents,
  project,
  RUNNING_DONE,
  RUNNING_PLAN,
  RUNNING_REPLY,
  RUNNING_TEST_EDIT,
  RUNNING_TEST_LINES,
  RUNNING_TURN_VIEW_EDIT,
  runningThread,
  type ChangedFile,
  type PlanItem,
  type ThreadMeta,
} from "./data"
import type { Conn } from "./nav"

export type ThreadState = "approval" | "question" | "running" | "failed" | "unread" | "done"

export interface Live {
  text: string
  output: Record<string, string>
}

export interface Queued {
  id: string
  text: string
}

export interface PendingApproval {
  requestId: string
  title: string
  description?: string | undefined
  command?: string | undefined
}

export interface PendingQuestion {
  requestId: string
  questions: QuestionView[]
}

/** 状态类别：筛选、按状态分组和按状态排序都用它，顺序就是按状态排的先后。 */
export type Category = "attention" | "error" | "unread" | "working" | "done"

export const CATEGORIES: Array<{ key: Category; label: string }> = [
  { key: "attention", label: "需要处理" },
  { key: "error", label: "出错" },
  { key: "unread", label: "未读" },
  { key: "working", label: "进行中" },
  { key: "done", label: "已完成" },
]

export interface Arrangement {
  grouping: "project" | "time" | "status"
  sort: "updated" | "status"
  filters: Category[]
  archived: boolean
}

export interface NewThreadInput {
  projectId: string
  agent: string
  model: string
  permission: string
  text: string
}

interface Step {
  delay: number
  run: () => void
}

const RUNNING = "t-running"

function payloadOf(item: ThreadEvent): Record<string, unknown> {
  return (item.payload ?? {}) as Record<string, unknown>
}

function requestIdOf(item: ThreadEvent): string | undefined {
  const payload = payloadOf(item)
  const id = payload.requestId ?? payload.id
  return typeof id === "string" ? id : undefined
}

class ProtoStore {
  events: Record<string, ThreadEvent[]> = initialEvents()
  meta: Record<string, ThreadMeta> = Object.fromEntries(INITIAL_META.map((item) => [item.id, item]))
  order: string[] = INITIAL_META.map((item) => item.id)
  plans: Record<string, PlanItem[]> = { [RUNNING]: RUNNING_PLAN.map((item) => ({ ...item })) }
  live: Record<string, Live> = {}
  queued: Record<string, Queued[]> = {}
  drafts: Record<string, string> = {}
  seen = new Set(INITIAL_META.filter((item) => item.id !== "t-unread").map((item) => item.id))
  /** 置顶存在电脑上，窗口和手机看到的是同一份（原型里只在内存）。 */
  pinned = new Set<string>(["t-question", "t-market"])
  archived = new Set<string>()
  arrangement: Arrangement = {
    grouping: "project",
    sort: "updated",
    filters: CATEGORIES.map((item) => item.key),
    archived: false,
  }
  expanded: Record<string, boolean> = { pigcode: true, docs: true, blog: false }
  open: string | undefined
  conn: Conn = "online"

  private tokens: Record<string, number> = {}
  private started = new Set<string>()
  private fileCache = new WeakMap<ThreadEvent[], ChangedFile[]>()
  private counter = 0
  private version = 0
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getVersion = () => this.version

  emit(): void {
    this.version += 1
    for (const listener of this.listeners) listener()
  }

  // ─── 读 ────────────────────────────────────────────────

  stateOf(id: string): ThreadState {
    const events = this.events[id] ?? []
    const approvals = new Set<string>()
    const questions = new Set<string>()
    let running = false
    let failed = false
    for (const item of events) {
      const request = requestIdOf(item)
      switch (item.type) {
        case "approval.requested":
          if (request) approvals.add(request)
          break
        case "approval.resolved":
          if (request) approvals.delete(request)
          break
        case "question.requested":
          if (request) questions.add(request)
          break
        case "question.answered":
          if (request) questions.delete(request)
          break
        case "run.started":
          running = true
          failed = false
          break
        case "run.completed":
        case "run.interrupted":
          running = false
          break
        case "run.failed":
          running = false
          failed = true
          break
        default:
          break
      }
    }
    if (approvals.size > 0) return "approval"
    if (questions.size > 0) return "question"
    if (running) return "running"
    if (failed) return "failed"
    return this.seen.has(id) ? "done" : "unread"
  }

  needsAttention(id: string): boolean {
    const state = this.stateOf(id)
    return state === "approval" || state === "question" || state === "unread"
  }

  pendingApproval(id: string): PendingApproval | undefined {
    const resolved = new Set(
      (this.events[id] ?? []).filter((item) => item.type === "approval.resolved").map(requestIdOf),
    )
    const request = [...(this.events[id] ?? [])]
      .reverse()
      .find((item) => item.type === "approval.requested" && !resolved.has(requestIdOf(item)))
    if (!request) return undefined
    const payload = payloadOf(request)
    return {
      requestId: requestIdOf(request)!,
      title: String(payload.title ?? "允许这次操作？"),
      description: typeof payload.description === "string" ? payload.description : undefined,
      command: typeof payload.command === "string" ? payload.command : undefined,
    }
  }

  pendingQuestion(id: string): PendingQuestion | undefined {
    const answered = new Set(
      (this.events[id] ?? []).filter((item) => item.type === "question.answered").map(requestIdOf),
    )
    const request = [...(this.events[id] ?? [])]
      .reverse()
      .find((item) => item.type === "question.requested" && !answered.has(requestIdOf(item)))
    if (!request) return undefined
    const payload = payloadOf(request)
    return { requestId: requestIdOf(request)!, questions: payload.questions as QuestionView[] }
  }

  /** 正在进行的那次 run。 */
  runId(id: string): string | undefined {
    let open: string | undefined
    for (const item of this.events[id] ?? []) {
      if (item.type === "run.started") open = item.runId ?? undefined
      if (item.type === "run.completed" || item.type === "run.failed" || item.type === "run.interrupted")
        open = undefined
    }
    return open
  }

  /** 正在运行的工具，活动条用。 */
  activeTool(id: string): { name: string; text: string; since: number } | undefined {
    const done = new Set<string>()
    let active: ThreadEvent | undefined
    for (const item of this.events[id] ?? []) {
      const toolId = payloadOf(item).toolCallId
      if (item.type === "tool.completed" && typeof toolId === "string") done.add(toolId)
      if (item.type === "tool.started") active = item
    }
    if (!active) return undefined
    const payload = payloadOf(active)
    if (done.has(String(payload.toolCallId))) return undefined
    const input = (payload.input ?? {}) as Record<string, unknown>
    const name = String(payload.name ?? "")
    const text =
      typeof input.command === "string"
        ? input.command
        : typeof input.file_path === "string"
          ? input.file_path.split("/").at(-1)!
          : name
    return { name, text, since: Date.parse(active.createdAt) }
  }

  runStartedAt(id: string): number | undefined {
    const started = [...(this.events[id] ?? [])].reverse().find((item) => item.type === "run.started")
    return started ? Date.parse(started.createdAt) : undefined
  }

  files(id: string): ChangedFile[] {
    const events = this.events[id] ?? []
    const cached = this.fileCache.get(events)
    if (cached) return cached
    const meta = this.meta[id]
    const files = changedFiles(events, project(meta?.projectId ?? "pigcode").root)
    this.fileCache.set(events, files)
    return files
  }

  /** 没归档的会话，按更新时间排。 */
  active(): string[] {
    return this.order.filter((id) => !this.archived.has(id))
  }

  category(id: string): Category {
    const state = this.stateOf(id)
    if (state === "approval" || state === "question") return "attention"
    if (state === "failed") return "error"
    if (state === "unread") return "unread"
    if (state === "running") return "working"
    return "done"
  }

  /** 菜单里要列的会话：按筛选、归档和搜索过滤，再按排序方式排好。 */
  arranged(query: string): string[] {
    const { filters, archived, sort } = this.arrangement
    const words = query.trim()
    const ids = this.order.filter(
      (id) =>
        this.archived.has(id) === archived &&
        (archived || filters.includes(this.category(id))) &&
        (!words || (this.meta[id]?.title ?? "").includes(words)),
    )
    if (sort === "updated") return ids
    const rank = (id: string) => CATEGORIES.findIndex((item) => item.key === this.category(id))
    return [...ids].sort((a, b) => rank(a) - rank(b))
  }

  filtersActive(): boolean {
    return this.arrangement.archived || this.arrangement.filters.length < CATEGORIES.length
  }

  counts(): { attention: number; running: number } {
    let attention = 0
    let running = 0
    for (const id of this.active()) {
      if (this.needsAttention(id)) attention += 1
      if (this.stateOf(id) === "running") running += 1
    }
    return { attention, running }
  }

  // ─── 写 ────────────────────────────────────────────────

  setConn(conn: Conn): void {
    if (this.conn === conn) return
    this.conn = conn
    this.emit()
  }

  setOpen(id: string | undefined): void {
    this.open = id
    if (id) {
      if (id === RUNNING) this.ensureLive()
      if (!this.seen.has(id)) {
        this.seen.add(id)
        this.emit()
      }
    }
  }

  setDraft(id: string, text: string): void {
    this.drafts[id] = text
    this.emit()
  }

  togglePin(id: string): void {
    if (this.pinned.has(id)) this.pinned.delete(id)
    else this.pinned.add(id)
    this.emit()
  }

  /** 归档的会话同时取消置顶；在已归档的会话里发消息，它会自动回来（同桌面）。 */
  toggleArchive(id: string): void {
    if (this.archived.has(id)) this.archived.delete(id)
    else {
      this.archived.add(id)
      this.pinned.delete(id)
    }
    this.emit()
  }

  markRead(id: string): void {
    this.seen.add(id)
    this.emit()
  }

  markUnread(id: string): void {
    if (this.open !== id) this.seen.delete(id)
    this.emit()
  }

  markAllRead(): void {
    for (const id of this.order) this.seen.add(id)
    this.emit()
  }

  setArrangement(patch: Partial<Arrangement>): void {
    this.arrangement = { ...this.arrangement, ...patch }
    this.emit()
  }

  /** 状态筛选多选；取消到一个不剩时回到全选（同桌面）。 */
  toggleFilter(key: Category): void {
    const filters = this.arrangement.filters.includes(key)
      ? this.arrangement.filters.filter((item) => item !== key)
      : [...this.arrangement.filters, key]
    this.setArrangement({ filters: filters.length === 0 ? CATEGORIES.map((item) => item.key) : filters })
  }

  toggleProject(projectId: string): void {
    this.expanded = { ...this.expanded, [projectId]: !this.expanded[projectId] }
    this.emit()
  }

  resolveApproval(id: string, requestId: string, decision: ApprovalDecision): void {
    const run = this.runId(id) ?? `r-${id}`
    this.append(id, event(id, run, "approval.resolved", { requestId, decision }))
    this.emit()
    if (id !== "t-approval") {
      this.play(id, [{ delay: 600, run: () => this.endRun(id, run, "run.completed") }])
      return
    }
    if (decision === "deny") {
      this.play(id, [
        {
          delay: 300,
          run: () =>
            this.append(id, event(id, run, "tool.completed", {
              toolCallId: "ap-bash",
              name: "Bash",
              input: { command: "pnpm vitest run packages/ui-shell", description: "跑侧栏的单测" },
              output: "用户拒绝了这次运行",
              exitCode: 1,
            })),
        },
        ...this.streamSteps(id, run, "好的，不跑单测。改动已经保存在 sidebar-arrangement.ts，回到电脑上可以手动跑 `pnpm vitest run packages/ui-shell`。"),
        { delay: 300, run: () => this.endRun(id, run, "run.completed") },
      ])
      return
    }
    const lines = [
      " RUN  v4.0.16 /Users/liuqin/workspace/pigcode/frontend",
      " ✓ packages/ui-shell/src/sidebar-arrangement.test.ts (15 tests) 33ms",
      " ✓ packages/ui-shell/src/workspace-sidebar.test.tsx (22 tests) 410ms",
      "",
      " Test Files  2 passed (2)",
      "      Tests  37 passed (37)",
    ]
    this.play(id, [
      ...lines.map((line) => ({ delay: 500, run: () => this.appendOutput(id, "ap-bash", line) })),
      {
        delay: 500,
        run: () => {
          this.append(id, event(id, run, "tool.completed", {
            toolCallId: "ap-bash",
            name: "Bash",
            input: { command: "pnpm vitest run packages/ui-shell", description: "跑侧栏的单测" },
            output: lines.join("\n"),
            exitCode: 0,
          }))
          this.clearOutput(id)
        },
      },
      ...this.streamSteps(id, run, "单测都过了。按状态分组已经接到侧栏和 ⌘数字，换分组时菜单不会关掉。"),
      { delay: 300, run: () => this.endRun(id, run, "run.completed") },
    ])
  }

  answerQuestion(id: string, requestId: string, answers: string[]): void {
    const run = this.runId(id) ?? `r-${id}`
    const answer = answers[0] || "只做中继"
    this.append(id, event(id, run, "question.answered", { requestId, answers }))
    this.emit()
    const path = "/Users/liuqin/workspace/pigcode/docs/mobile/connection.md"
    const input = { file_path: path, content: `# 手机端的连接方式\n\n## 结论\n\n第一版：${answer}。\n` }
    this.play(id, [
      ...this.streamSteps(id, run, `好，按「${answer}」写。决策稿放在 docs/mobile/connection.md，列出三种方案的代价和第一版的取舍。`),
      { delay: 500, run: () => this.append(id, event(id, run, "tool.started", { toolCallId: "q-write", name: "Write", input })) },
      { delay: 900, run: () => this.append(id, event(id, run, "tool.completed", { toolCallId: "q-write", name: "Write", input, output: "" })) },
      { delay: 300, run: () => this.endRun(id, run, "run.completed") },
    ])
  }

  /** 发送：运行中排进队列，否则开始新的一轮。 */
  send(id: string, text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    this.drafts[id] = ""
    if (this.runId(id)) {
      this.counter += 1
      this.queued[id] = [...(this.queued[id] ?? []), { id: `q${this.counter}`, text: trimmed }]
      this.emit()
      return
    }
    this.startRun(id, trimmed)
  }

  /** 排队的消息「立即发送」：停下这一轮，用它开始新的一轮。 */
  sendNow(id: string, queuedId: string): void {
    const item = this.queued[id]?.find((entry) => entry.id === queuedId)
    if (!item) return
    this.queued[id] = (this.queued[id] ?? []).filter((entry) => entry.id !== queuedId)
    const run = this.runId(id)
    if (run) this.endRun(id, run, "run.interrupted", false)
    this.startRun(id, item.text)
  }

  /** 撤回排队的消息，文字回到输入框。 */
  withdraw(id: string, queuedId: string): void {
    const item = this.queued[id]?.find((entry) => entry.id === queuedId)
    if (!item) return
    this.queued[id] = (this.queued[id] ?? []).filter((entry) => entry.id !== queuedId)
    const draft = this.drafts[id] ?? ""
    this.drafts[id] = draft ? `${item.text}\n${draft}` : item.text
    this.emit()
  }

  stop(id: string): void {
    const run = this.runId(id)
    if (!run) return
    this.endRun(id, run, "run.interrupted")
  }

  createThread(input: NewThreadInput): string {
    this.counter += 1
    const id = `t-new-${this.counter}`
    const title = input.text.split("\n")[0]!.slice(0, 24)
    this.meta[id] = {
      id,
      projectId: input.projectId,
      title,
      agent: input.agent,
      model: input.model,
      permission: input.permission,
      group: "今天",
      time: "刚刚",
    }
    this.order = [id, ...this.order]
    this.events[id] = []
    this.seen.add(id)
    this.startRun(id, input.text.trim())
    return id
  }

  /** 第一次打开「运行中」的会话时开始推演。 */
  ensureLive(): void {
    if (this.started.has(RUNNING)) return
    this.started.add(RUNNING)
    this.play(RUNNING, this.runningSteps())
  }

  /** 把「运行中」的会话重置到开头，再推演一遍。 */
  replay(): void {
    this.cancel(RUNNING)
    this.events[RUNNING] = runningThread()
    this.plans[RUNNING] = RUNNING_PLAN.map((item) => ({ ...item }))
    delete this.live[RUNNING]
    this.queued[RUNNING] = []
    this.seen.add(RUNNING)
    this.meta[RUNNING] = { ...this.meta[RUNNING]!, time: "刚刚" }
    this.started.delete(RUNNING)
    this.ensureLive()
    this.emit()
  }

  // ─── 内部 ──────────────────────────────────────────────

  private append(id: string, ...items: ThreadEvent[]): void {
    this.events[id] = [...(this.events[id] ?? []), ...items]
  }

  private appendOutput(id: string, toolId: string, line: string): void {
    const live = this.live[id] ?? { text: "", output: {} }
    const before = live.output[toolId]
    this.live[id] = { ...live, output: { ...live.output, [toolId]: before ? `${before}\n${line}` : line } }
  }

  private clearOutput(id: string): void {
    const live = this.live[id]
    if (live) this.live[id] = { ...live, output: {} }
  }

  private setText(id: string, text: string): void {
    const live = this.live[id] ?? { text: "", output: {} }
    this.live[id] = { ...live, text }
  }

  private setPlan(id: string, index: number, status: PlanItem["status"]): void {
    const plan = this.plans[id]
    if (!plan?.[index]) return
    this.plans[id] = plan.map((item, at) => (at === index ? { ...item, status } : item))
  }

  private bump(id: string): void {
    this.order = [id, ...this.order.filter((item) => item !== id)]
    const meta = this.meta[id]
    if (meta) this.meta[id] = { ...meta, group: "今天", time: "刚刚" }
  }

  private startRun(id: string, text: string): void {
    this.counter += 1
    const run = `r-${id}-${this.counter}`
    this.append(id, event(id, run, "run.started", { text }))
    this.archived.delete(id)
    this.bump(id)
    this.emit()
    const root = project(this.meta[id]?.projectId ?? "pigcode").root
    const input = { file_path: `${root}/README.md` }
    const short = text.length > 18 ? `${text.slice(0, 18)}…` : text
    this.play(id, [
      { delay: 700, run: () => this.append(id, event(id, run, "reasoning.completed", { text: "先看看项目里相关的文件。", durationMs: 1800 })) },
      { delay: 500, run: () => this.append(id, event(id, run, "tool.started", { toolCallId: `${run}-read`, name: "Read", input })) },
      { delay: 700, run: () => this.append(id, event(id, run, "tool.completed", { toolCallId: `${run}-read`, name: "Read", input, output: "" })) },
      ...this.streamSteps(id, run, `收到：「${short}」。这是原型里的假回复，真实的回复会从电脑上的 Agent 一段段传过来。`),
      { delay: 300, run: () => this.endRun(id, run, "run.completed") },
    ])
  }

  private endRun(id: string, run: string, type: "run.completed" | "run.interrupted", next = true): void {
    this.cancel(id)
    delete this.live[id]
    this.append(id, event(id, run, type, {}))
    if (this.open !== id) this.seen.delete(id)
    this.bump(id)
    this.emit()
    const queued = this.queued[id] ?? []
    if (next && queued.length > 0) {
      const [first, ...rest] = queued
      this.queued[id] = rest
      this.startRun(id, first!.text)
    }
  }

  private streamSteps(id: string, run: string, text: string): Step[] {
    const steps: Step[] = []
    for (let end = 3; end < text.length + 3; end += 3) {
      const slice = text.slice(0, end)
      steps.push({ delay: 45, run: () => this.setText(id, slice) })
    }
    steps.push({
      delay: 150,
      run: () => {
        this.setText(id, "")
        this.append(id, event(id, run, "message.completed", { role: "assistant", text }))
      },
    })
    return steps
  }

  private runningSteps(): Step[] {
    const t = RUNNING
    const r = "r-running"
    const bash = { command: "pnpm vitest run packages/ui-chat && pnpm -r typecheck", description: "跑单测和类型检查" }
    return [
      { delay: 1200, run: () => this.append(t, event(t, r, "tool.started", { toolCallId: "run-edit-2", name: "Edit", input: RUNNING_TURN_VIEW_EDIT })) },
      {
        delay: 2200,
        run: () => {
          this.append(t, event(t, r, "tool.completed", { toolCallId: "run-edit-2", name: "Edit", input: RUNNING_TURN_VIEW_EDIT, output: "" }))
          this.setPlan(t, 2, "done")
          this.setPlan(t, 3, "doing")
        },
      },
      { delay: 1200, run: () => this.append(t, event(t, r, "tool.started", { toolCallId: "run-edit-3", name: "Edit", input: RUNNING_TEST_EDIT })) },
      {
        delay: 1800,
        run: () => {
          this.append(t, event(t, r, "tool.completed", { toolCallId: "run-edit-3", name: "Edit", input: RUNNING_TEST_EDIT, output: "" }))
          this.setPlan(t, 3, "done")
          this.setPlan(t, 4, "doing")
        },
      },
      ...this.streamSteps(t, r, RUNNING_REPLY),
      { delay: 600, run: () => this.append(t, event(t, r, "tool.started", { toolCallId: "run-bash", name: "Bash", input: bash })) },
      ...RUNNING_TEST_LINES.map((line) => ({ delay: 1100, run: () => this.appendOutput(t, "run-bash", line) })),
      {
        delay: 1100,
        run: () => {
          this.append(t, event(t, r, "tool.completed", { toolCallId: "run-bash", name: "Bash", input: bash, output: RUNNING_TEST_LINES.join("\n"), exitCode: 0 }))
          this.clearOutput(t)
          this.setPlan(t, 4, "done")
        },
      },
      ...this.streamSteps(t, r, RUNNING_DONE),
      { delay: 400, run: () => this.endRun(t, r, "run.completed") },
    ]
  }

  private cancel(id: string): void {
    this.tokens[id] = (this.tokens[id] ?? 0) + 1
  }

  /** 按顺序执行脚本；连接不在线时停住，连上再接着走。新的脚本会取消同一会话里旧的。 */
  private play(id: string, steps: Step[]): void {
    this.cancel(id)
    const token = this.tokens[id]
    let index = 0
    const tick = () => {
      if (this.tokens[id] !== token || index >= steps.length) return
      if (this.conn !== "online") {
        window.setTimeout(tick, 500)
        return
      }
      steps[index]!.run()
      index += 1
      this.emit()
      if (index < steps.length) window.setTimeout(tick, steps[index]!.delay)
    }
    if (steps.length > 0) window.setTimeout(tick, steps[0]!.delay)
  }
}

export const store = new ProtoStore()

/** 订阅原型状态；返回同一个 store，状态变化时重新渲染。 */
export function useProto(): ProtoStore {
  useSyncExternalStore(store.subscribe, store.getVersion)
  return store
}
