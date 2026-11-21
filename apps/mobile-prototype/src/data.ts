/**
 * 假数据：一台电脑、三个项目、九个会话。事件的形状和 Host 存的 ThreadEvent 一样，
 * 时间线直接交给 ui-chat 的 MessageList 渲染。
 */
import { structuredPatch } from "diff"
import type { ThreadEvent } from "@pigcode/contracts"

export const COMPUTER = {
  name: "liuqin 的 MacBook Pro",
  route: "中继 · 香港",
  latency: "46 毫秒",
  lastSeen: "18:42",
  relay: "relay.liuqin.dev",
  fingerprint: "3f9a 1c07 be42 9d5e 08c1 7a6f e230 4b9d 51c8 0f3e a7d2 6b14 c9e0 2f87 d413 5a6c",
}

export interface Project {
  id: string
  name: string
  root: string
}

export const PROJECTS: Project[] = [
  { id: "pigcode", name: "pigcode", root: "/Users/liuqin/workspace/pigcode/frontend" },
  { id: "docs", name: "docs", root: "/Users/liuqin/workspace/pigcode/docs" },
  { id: "blog", name: "blog", root: "/Users/liuqin/workspace/blog" },
]

export interface AgentInstance {
  id: string
  name: string
  models: string[]
}

export const AGENTS: AgentInstance[] = [
  { id: "claude", name: "Claude Code", models: ["Opus 4.8", "Sonnet 5.5"] },
  { id: "codex", name: "Codex", models: ["GPT-5.6", "GPT-5.6 mini"] },
  { id: "claude-work", name: "Claude Code（公司）", models: ["Opus 4.8"] },
]

export const PERMISSIONS = ["监督审批", "接受编辑", "自动审批", "完全访问"] as const

export type Group = "今天" | "昨天" | "更早"

export interface ThreadMeta {
  id: string
  projectId: string
  title: string
  agent: string
  model: string
  permission: string
  group: Group
  time: string
}

export interface PlanItem {
  text: string
  status: "done" | "doing" | "todo"
}

export function project(id: string): Project {
  return PROJECTS.find((item) => item.id === id) ?? PROJECTS[0]!
}

// ─── 事件 ────────────────────────────────────────────────

let seq = 0
const NOW = Date.now()

/** 一条线程事件；at 是毫秒时间戳。 */
export function event(
  threadId: string,
  runId: string | null,
  type: string,
  payload: unknown,
  at: number = Date.now(),
): ThreadEvent {
  seq += 1
  return {
    seq,
    threadId,
    runId,
    type,
    payload,
    schemaVersion: 1,
    createdAt: new Date(at).toISOString(),
  } as unknown as ThreadEvent
}

const ago = (seconds: number) => NOW - seconds * 1000

/** 一次工具调用；不给 endedAgo 时停在运行中。 */
function tool(
  threadId: string,
  runId: string,
  id: string,
  name: string,
  input: Record<string, unknown>,
  startedAgo: number,
  endedAgo?: number,
  output?: string,
  extra?: Record<string, unknown>,
): ThreadEvent[] {
  const started = event(threadId, runId, "tool.started", { toolCallId: id, name, input }, ago(startedAgo))
  if (endedAgo === undefined) return [started]
  return [
    started,
    event(
      threadId,
      runId,
      "tool.completed",
      { toolCallId: id, name, input, output, ...extra },
      ago(endedAgo),
    ),
  ]
}

const FE = "/Users/liuqin/workspace/pigcode/frontend"

// ─── 等你确认：侧栏按状态分组 ─────────────────────────────

export const SIDEBAR_EDIT = {
  file_path: `${FE}/packages/ui-shell/src/sidebar-arrangement.ts`,
  _startLine: 38,
  old_string: `export function groupThreads(threads: Thread[], by: GroupBy): ThreadGroup[] {
  if (by === "project") return groupByProject(threads)
  return groupByTime(threads)
}
`,
  new_string: `export function groupThreads(threads: Thread[], by: GroupBy): ThreadGroup[] {
  if (by === "project") return groupByProject(threads)
  if (by === "status") return groupByStatus(threads)
  return groupByTime(threads)
}

/** 需要处理排在最前；已归档的会话不参与分组。 */
const STATUS_ORDER = ["attention", "error", "running", "draft", "done"] as const
`,
}

function approvalThread(): ThreadEvent[] {
  const t = "t-approval"
  const r = "r-approval"
  return [
    event(t, r, "run.started", {
      text: "侧栏加一个「按状态分组」：需要处理、出错、进行中、草稿、已完成。规则写在 sidebar-arrangement.ts，侧栏和 ⌘数字共用。",
    }, ago(260)),
    event(t, r, "reasoning.completed", {
      text: "先看现在的分组是怎么算的，再决定状态桶放在哪一层。",
      durationMs: 4200,
    }, ago(255)),
    ...tool(t, r, "ap-read", "Read", { file_path: `${FE}/packages/ui-shell/src/sidebar-arrangement.ts` }, 250, 249),
    ...tool(t, r, "ap-grep", "Grep", { pattern: "groupThreads", path: "packages/ui-shell/src" }, 248, 247,
      "packages/ui-shell/src/sidebar-arrangement.ts:38\npackages/ui-shell/src/workspace-sidebar.tsx:118"),
    ...tool(t, r, "ap-edit", "Edit", SIDEBAR_EDIT, 230, 226),
    event(t, r, "message.completed", {
      role: "assistant",
      text: "分组规则加好了：需要处理排在最前，已归档的会话不参与分组。接下来跑一下侧栏的单测。",
    }, ago(220)),
    ...tool(t, r, "ap-bash", "Bash", { command: "pnpm vitest run packages/ui-shell", description: "跑侧栏的单测" }, 214),
    event(t, r, "approval.requested", {
      requestId: "ap-1",
      title: "允许运行这条命令？",
      description: "跑侧栏的单测，确认按状态分组没有回归。",
      command: "pnpm vitest run packages/ui-shell",
    }, ago(213)),
  ]
}

// ─── 等你回答：连接方案的取舍 ─────────────────────────────

export const QUESTION = {
  requestId: "q-1",
  questions: [
    {
      header: "连接方式",
      question: "第一版只做中继，还是同时做局域网直连？",
      multiSelect: false,
      options: [
        { label: "只做中继", description: "在家在外都走中继，实现最简单" },
        { label: "中继加局域网直连", description: "在家时更快，但要多做一套发现和切换" },
        { label: "先做局域网直连", description: "第一个切片最小，外网以后再接" },
      ],
    },
  ],
}

function questionThread(): ThreadEvent[] {
  const t = "t-question"
  const r = "r-question"
  return [
    event(t, r, "run.started", {
      text: "把手机端连接调研的结论整理成一页决策稿，列出几种方案的代价。",
    }, ago(1240)),
    ...tool(t, r, "q-read", "Read", { file_path: "/Users/liuqin/workspace/pigcode/docs/research/mobile-connectivity.md" }, 1230, 1228),
    event(t, r, "message.completed", {
      role: "assistant",
      text: "调研里有三种走法，代价的差别主要在第一版要不要做局域网发现。写之前先确认一下方向。",
    }, ago(1200)),
    event(t, r, "question.requested", QUESTION, ago(1195)),
  ]
}

// ─── 运行中：时间线跑完只留最终回答 ───────────────────────

export const RUNNING_PLAN: PlanItem[] = [
  { text: "读现在的折叠逻辑", status: "done" },
  { text: "改分组规则：运行中不折叠", status: "done" },
  { text: "改折叠头：跑完写「用时 N 秒」", status: "doing" },
  { text: "补单测", status: "todo" },
  { text: "跑单测和类型检查", status: "todo" },
]

export function runningThread(): ThreadEvent[] {
  const t = "t-running"
  const r = "r-running"
  return [
    event(t, r, "run.started", {
      text: "会话时间线改一下：一轮运行中不折叠，跑完收成一行「用时 N 秒」，只留最终回答；出错或被停下时照样展开。",
    }, ago(52)),
    event(t, r, "reasoning.completed", {
      text: "折叠是在 turn-view 里按「有没有最终回答」判断的，分组在 summary-groups。两处都要动。",
      durationMs: 3100,
    }, ago(48)),
    ...tool(t, r, "run-read-1", "Read", { file_path: `${FE}/packages/ui-chat/src/summary-groups.ts` }, 44, 43),
    ...tool(t, r, "run-read-2", "Read", { file_path: `${FE}/packages/ui-chat/src/turn-view.tsx` }, 42, 41),
    event(t, r, "message.completed", {
      role: "assistant",
      text: "现在运行中也会把前面的工具收起来。我先改分组规则，再改折叠头。",
    }, ago(36)),
    ...tool(t, r, "run-edit-1", "Edit", {
      file_path: `${FE}/packages/ui-chat/src/summary-groups.ts`,
      _startLine: 61,
      old_string: "  if (turn.status !== \"running\" && hasFinalAnswer(turn)) return collapse(items)\n  return collapse(items)\n",
      new_string: "  if (turn.status === \"running\") return items\n  if (hasFinalAnswer(turn)) return collapse(items)\n  return items\n",
    }, 30, 27),
  ]
}

export const RUNNING_TURN_VIEW_EDIT = {
  file_path: `${FE}/packages/ui-chat/src/turn-view.tsx`,
  _startLine: 184,
  old_string: "      {ended ? <TurnFold label={t(\"chat.turn.done\")} /> : null}\n",
  new_string: "      {ended && !turn.error && turn.status !== \"interrupted\" ? (\n        <TurnFold label={t(\"chat.turn.elapsed\").replace(\"{n}\", seconds)} />\n      ) : null}\n",
}

export const RUNNING_TEST_EDIT = {
  file_path: `${FE}/packages/ui-chat/src/turns.test.tsx`,
  _startLine: 412,
  old_string: "})\n",
  new_string: "  it(\"keeps the work open while the turn is running\", () => {\n    const turn = runningTurn([read(\"a.ts\"), edit(\"a.ts\")])\n    expect(collapseWork(turn)).toHaveLength(2)\n  })\n})\n",
}

export const RUNNING_REPLY =
  "改好了。运行中的那一轮现在一直展开，末尾是「工作中」和计时；跑完以后收成一行「用时 N 秒」，只留最终回答。出错、被停下或者没有最终回答时照样展开。下面跑单测和类型检查。"

export const RUNNING_TEST_LINES = [
  " RUN  v4.0.16 /Users/liuqin/workspace/pigcode/frontend",
  "",
  " ✓ packages/ui-chat/src/summary-groups.test.ts (12 tests) 41ms",
  " ✓ packages/ui-chat/src/turns.test.tsx (32 tests) 188ms",
  " ✓ packages/ui-chat/src/tool-model.test.ts (18 tests) 22ms",
  " ✓ packages/ui-chat/src/chat-view.test.tsx (27 tests) 912ms",
  " ✓ packages/ui-chat/src/markdown.test.tsx (21 tests) 133ms",
  " ✓ packages/ui-chat/src/question-card.test.tsx (6 tests) 87ms",
  " ✓ packages/ui-chat/src/workflow-card.test.tsx (9 tests) 64ms",
  " ✓ packages/ui-chat/src/turn-navigator.test.tsx (7 tests) 58ms",
  "",
  " Test Files  8 passed (8)",
  "      Tests  132 passed (132)",
  "   Duration  2.41s",
  "",
  "> pnpm -r typecheck",
  "packages/contracts typecheck: Done",
  "packages/ui-primitives typecheck: Done",
  "packages/ui-composer typecheck: Done",
  "packages/ui-chat typecheck: Done",
  "apps/desktop typecheck: Done",
]

export const RUNNING_DONE = "单测和类型检查都过了。改动在 summary-groups.ts、turn-view.tsx 和 turns.test.tsx 三个文件里。"

// ─── 跑完没看：Host 重启后的会话状态 ──────────────────────

function unreadThread(): ThreadEvent[] {
  const t = "t-unread"
  const r = "r-unread"
  return [
    event(t, r, "run.started", {
      text: "Host 重启以后，重启前在跑的会话在侧栏里一直显示运行中，修一下（#84）。",
    }, ago(2400)),
    event(t, r, "reasoning.completed", {
      text: "会话状态取的是最近一次 run 的状态。Host 重启后旧 run 没人结束，所以一直是 running。",
      durationMs: 5600,
    }, ago(2395)),
    ...tool(t, r, "un-read", "Read", { file_path: "/Users/liuqin/workspace/pigcode/frontend/apps/host/src/thread-status.ts" }, 2390, 2389),
    ...tool(t, r, "un-grep", "Grep", { pattern: "status: \"running\"", path: "apps/host/src" }, 2388, 2387,
      "apps/host/src/thread-status.ts:21\napps/host/src/runs.ts:88"),
    ...tool(t, r, "un-edit-1", "Edit", {
      file_path: "/Users/liuqin/workspace/pigcode/frontend/apps/host/src/thread-status.ts",
      _startLine: 18,
      old_string: `export function threadStatus(runs: RunRecord[]): ThreadStatus {
  const last = runs.at(-1)
  if (!last) return "idle"
  return last.status
}
`,
      new_string: `export function threadStatus(runs: RunRecord[], hostStartedAt: number): ThreadStatus {
  const last = runs.at(-1)
  if (!last) return "idle"
  // 上一个 Host 进程里没结束的 run，重启后按已停下处理。
  if (last.status === "running" && last.startedAt < hostStartedAt) return "interrupted"
  return last.status
}
`,
    }, 2370, 2366),
    ...tool(t, r, "un-edit-2", "Edit", {
      file_path: "/Users/liuqin/workspace/pigcode/frontend/apps/host/src/thread-status.test.ts",
      _startLine: 40,
      old_string: `  it("returns the last run status", () => {
    expect(threadStatus([run("completed")], 0)).toBe("completed")
  })
`,
      new_string: `  it("returns the last run status", () => {
    expect(threadStatus([run("completed")], 0)).toBe("completed")
  })

  it("treats a run left over from the previous host as interrupted", () => {
    expect(threadStatus([run("running", 100)], 200)).toBe("interrupted")
  })
`,
    }, 2360, 2357),
    ...tool(t, r, "un-bash", "Bash", { command: "pnpm vitest run apps/host/src/thread-status.test.ts", description: "跑会话状态的单测" }, 2350, 2342,
      " ✓ apps/host/src/thread-status.test.ts (9 tests) 12ms\n\n Test Files  1 passed (1)\n      Tests  9 passed (9)", { exitCode: 0 }),
    event(t, r, "message.completed", {
      role: "assistant",
      text: "修好了。Host 启动时记下自己的启动时间；算会话状态时，如果最近一次 run 还标着运行中、开始时间却早于这次启动，就按「已停下」处理。补了一条单测，9 条都过了。",
    }, ago(2330)),
    event(t, r, "run.completed", {}, ago(2328)),
  ]
}

// ─── 出错：升级 Electron ─────────────────────────────────

function failedThread(): ThreadEvent[] {
  const t = "t-failed"
  const r = "r-failed"
  return [
    event(t, r, "run.started", { text: "把 Electron 升到 43，跑一遍原生模块的重新编译。" }, ago(9300)),
    ...tool(t, r, "f-add", "Bash", { command: "pnpm add -D electron@43.4.1 --filter @pigcode/desktop", description: "升级 Electron" }, 9290, 9270, "+ electron 43.4.1", { exitCode: 0 }),
    ...tool(t, r, "f-rebuild", "Bash", { command: "pnpm --dir apps/desktop rebuild:native", description: "重新编译原生模块" }, 9260, 9200,
      "gyp info using node-gyp@11.4.2\ngyp ERR! build error\ngyp ERR! stack Error: `make` failed with exit code: 2", { exitCode: 1 }),
    event(t, r, "run.failed", { message: "node-pty 编译失败：gyp ERR! build error（退出码 1）" }, ago(9195)),
  ]
}

// ─── 已完成 ──────────────────────────────────────────────

function doneThread(id: string, user: string, reply: string, endedAgo: number): ThreadEvent[] {
  const r = `r-${id}`
  return [
    event(id, r, "run.started", { text: user }, ago(endedAgo + 90)),
    event(id, r, "message.completed", { role: "assistant", text: reply }, ago(endedAgo + 2)),
    event(id, r, "run.completed", {}, ago(endedAgo)),
  ]
}

export const INITIAL_META: ThreadMeta[] = [
  { id: "t-running", projectId: "pigcode", title: "时间线跑完只留最终回答", agent: "Claude Code", model: "Opus 4.8", permission: "接受编辑", group: "今天", time: "刚刚" },
  { id: "t-approval", projectId: "pigcode", title: "给侧栏加按状态分组", agent: "Claude Code", model: "Opus 4.8", permission: "监督审批", group: "今天", time: "18:38" },
  { id: "t-question", projectId: "docs", title: "手机端连接方案的取舍", agent: "Claude Code", model: "Sonnet 5.5", permission: "完全访问", group: "今天", time: "18:21" },
  { id: "t-unread", projectId: "pigcode", title: "Host 重启后会话状态不更新", agent: "Codex", model: "GPT-5.6", permission: "接受编辑", group: "今天", time: "18:02" },
  { id: "t-failed", projectId: "pigcode", title: "升级 Electron 到 43", agent: "Codex", model: "GPT-5.6", permission: "完全访问", group: "今天", time: "16:07" },
  { id: "t-readme", projectId: "pigcode", title: "README 补上 Linux 的安装说明", agent: "Claude Code", model: "Sonnet 5.5", permission: "接受编辑", group: "昨天", time: "21:14" },
  { id: "t-market", projectId: "pigcode", title: "整理插件市场的分类", agent: "Claude Code", model: "Opus 4.8", permission: "接受编辑", group: "昨天", time: "15:03" },
  { id: "t-bark", projectId: "docs", title: "调研 Bark 推送在大陆能不能用", agent: "Claude Code", model: "Sonnet 5.5", permission: "完全访问", group: "更早", time: "11月18日" },
  { id: "t-weekly", projectId: "blog", title: "写一篇手机端规划的周报", agent: "Claude Code", model: "Sonnet 5.5", permission: "完全访问", group: "更早", time: "11月17日" },
]

export function initialEvents(): Record<string, ThreadEvent[]> {
  return {
    "t-running": runningThread(),
    "t-approval": approvalThread(),
    "t-question": questionThread(),
    "t-unread": unreadThread(),
    "t-failed": failedThread(),
    "t-readme": doneThread("t-readme", "README 补一段 Linux 的安装说明：AppImage 和 deb 两种。", "加好了，放在「安装」一节的 macOS 后面，两种包各一段，附了校验 SHA-256 的命令。", 75600),
    "t-market": doneThread("t-market", "插件市场的分类太碎了，合并成 Agent、工具、界面三类。", "合并好了。原来的 11 个分类收成 3 类，旧分类名写进了 aliases，已安装的插件不受影响。", 97200),
    "t-bark": doneThread("t-bark", "查一下 Bark 在大陆网络下推送到 iPhone 稳不稳。", "结论写在 research/bark.md：自建 bark-server 直连 APNs，可以加密正文；APNs 在大陆没有可靠性数据，只能当提醒用。", 259200),
    "t-weekly": doneThread("t-weekly", "根据这周的地图进展写一篇周报。", "写好了，草稿在 posts/2026-11-17-mobile.md，按「定了什么、还在查什么、下周做什么」分三段。", 345600),
  }
}

// ─── 改动 ────────────────────────────────────────────────

export interface DiffRow {
  kind: "add" | "remove" | "context" | "gap"
  text: string
  oldNo?: number | undefined
  newNo?: number | undefined
}

export interface ChangedFile {
  path: string
  name: string
  dir: string
  added: number
  removed: number
  rows: DiffRow[]
}

function relative(path: string, root: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}

/** 从写文件类工具算出每个文件的统一 diff。 */
export function changedFiles(events: readonly ThreadEvent[], root: string): ChangedFile[] {
  const files = new Map<string, ChangedFile>()
  for (const item of events) {
    if (item.type !== "tool.completed") continue
    const payload = item.payload as { name?: string; input?: Record<string, unknown> }
    const name = payload.name?.toLowerCase()
    if (name !== "edit" && name !== "write") continue
    const input = payload.input ?? {}
    const path = typeof input.file_path === "string" ? input.file_path : undefined
    if (!path) continue
    const before = name === "write" ? "" : String(input.old_string ?? "")
    const after = name === "write" ? String(input.content ?? "") : String(input.new_string ?? "")
    const start = typeof input._startLine === "number" ? input._startLine : 1
    const rel = relative(path, root)
    const slash = rel.lastIndexOf("/")
    const file = files.get(path) ?? {
      path,
      name: slash < 0 ? rel : rel.slice(slash + 1),
      dir: slash < 0 ? "" : rel.slice(0, slash),
      added: 0,
      removed: 0,
      rows: [],
    }
    if (file.rows.length > 0) file.rows.push({ kind: "gap", text: "" })
    const patch = structuredPatch(rel, rel, before, after, "", "", { context: 3 })
    for (const hunk of patch.hunks) {
      let oldNo = start + hunk.oldStart - 1
      let newNo = start + hunk.newStart - 1
      for (const line of hunk.lines) {
        if (line.startsWith("\\")) continue
        const text = line.slice(1)
        if (line.startsWith("+")) {
          file.rows.push({ kind: "add", text, newNo: newNo++ })
          file.added += 1
        } else if (line.startsWith("-")) {
          file.rows.push({ kind: "remove", text, oldNo: oldNo++ })
          file.removed += 1
        } else {
          file.rows.push({ kind: "context", text, oldNo: oldNo++, newNo: newNo++ })
        }
      }
    }
    files.set(path, file)
  }
  return [...files.values()]
}
