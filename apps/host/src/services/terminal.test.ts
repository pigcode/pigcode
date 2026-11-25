/** 用 fake PTY 工厂验证 open/write/output/resize/close，不加载原生模块。 */
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "cordis"
import { afterEach, describe, expect, it } from "vitest"
import { apply as projects } from "./projects"
import { apply as storage } from "./storage"
import {
  defaultShell,
  shellName,
  apply as terminal,
  type PtyFactory,
  type PtySpawnInput,
} from "./terminal"
import { apply as threads } from "./threads"

/** 单个 fake PTY 的内部状态。 */
interface FakeHandle {
  data: Array<(chunk: string) => void>
  exit: Array<(event: { exitCode: number }) => void>
  alive: boolean
}

/** fake PTY 工厂及其可观测的调用记录。 */
interface FakePty {
  factory: PtyFactory
  resizes: Array<[number, number]>
  writes: string[]
  spawns: PtySpawnInput[]
  readonly killed: boolean
  readonly killCount: number
  /** 触发最近一次 spawn 的退出事件，模拟 shell 自行结束。 */
  exit(exitCode?: number): void
  /** 直接从最近一次（或指定序号）spawn 的 PTY 推送输出，模拟后台进程持续写屏。 */
  emit(data: string, index?: number): void
}

const contexts: Context[] = []
const roots: string[] = []

/** 创建 fake PTY；write 会同步把转换后的输出广播回 data 监听器。 */
function fakePty(transform: (data: string) => string = (data) => data): FakePty {
  const resizes: Array<[number, number]> = []
  const writes: string[] = []
  const spawns: PtySpawnInput[] = []
  const handles: FakeHandle[] = []
  let killCount = 0

  const factory: PtyFactory = {
    spawn(input) {
      spawns.push(input)
      const state: FakeHandle = { data: [], exit: [], alive: true }
      handles.push(state)
      return {
        onData(listener) {
          state.data.push(listener)
        },
        onExit(listener) {
          state.exit.push(listener)
        },
        write(data) {
          writes.push(data)
          if (!state.alive) return
          for (const listener of [...state.data]) listener(transform(data))
        },
        resize(cols, rows) {
          resizes.push([cols, rows])
        },
        kill() {
          if (!state.alive) return
          state.alive = false
          killCount += 1
          for (const listener of [...state.exit]) listener({ exitCode: 0 })
        },
      }
    },
  }

  return {
    factory,
    resizes,
    writes,
    spawns,
    get killed() {
      return killCount > 0
    },
    get killCount() {
      return killCount
    },
    exit(exitCode = 0) {
      const state = handles.at(-1)
      if (!state) throw new Error("no pty spawned")
      if (!state.alive) return
      state.alive = false
      for (const listener of [...state.exit]) listener({ exitCode })
    },
    emit(data: string, index = handles.length - 1) {
      const state = handles[index]
      if (!state) throw new Error("no pty spawned")
      if (!state.alive) return
      for (const listener of [...state.data]) listener(data)
    },
  }
}

/** 建立带 terminal 服务的内存 Host 与临时项目。 */
async function setupTerminal(pty: FakePty, options: { scrollbackBytes?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pigcode-terminal-"))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(terminal, {
    ptyFactory: pty.factory,
    ...(options.scrollbackBytes !== undefined ? { scrollbackBytes: options.scrollbackBytes } : {}),
  })
  const project = ctx.projects.add(root)
  const thread = ctx.threads.create(project.id, "Terminal", "fake")
  return { ctx, project, thread, root }
}

/** 等待异步条件成立；fake 输出是同步的，只用于保持与真实 PTY 一致。 */
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("condition not met")
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
  )
})

describe("default shell", () => {
  it("falls back to a shell that exists on the platform", () => {
    const platform = process.platform
    const shell = process.env.SHELL
    try {
      delete process.env.SHELL
      Object.defineProperty(process, "platform", { value: "linux" })
      expect(defaultShell()).toBe("/bin/sh")
      Object.defineProperty(process, "platform", { value: "darwin" })
      expect(defaultShell()).toBe("/bin/zsh")
    } finally {
      Object.defineProperty(process, "platform", { value: platform })
      if (shell !== undefined) process.env.SHELL = shell
    }
  })
})

describe("terminal service", () => {
  it("echoes input and closes", async () => {
    const data: string[] = []
    const pty = fakePty((write) => `echo:${write}`)
    const { ctx, thread, root } = await setupTerminal(pty)

    const opened = await ctx.terminal.open({ threadId: thread.id }, 80, 24)
    const unsubscribe = ctx.terminal.subscribe(opened.id, (chunk) => data.push(chunk))

    ctx.terminal.write(opened.id, "hi\n")
    await waitFor(() => data.join("").includes("echo:hi"))
    expect(data.join("")).toBe("echo:hi\n")

    unsubscribe()
    ctx.terminal.write(opened.id, "ignored\n")
    expect(data.join("")).toBe("echo:hi\n")

    ctx.terminal.resize(opened.id, 100, 30)
    expect(pty.resizes).toEqual([[100, 30]])
    expect(pty.spawns).toEqual([
      { cwd: await realpath(root), cols: 80, rows: 24, shell: expect.any(String) },
    ])

    ctx.terminal.close(opened.id)
    expect(pty.killed).toBe(true)
    expect(() => ctx.terminal.write(opened.id, "closed")).toThrow("terminal not found")
  })

  it("opens several terminals per thread, each with its shell and cwd", async () => {
    const pty = fakePty()
    const { ctx, thread } = await setupTerminal(pty)

    const first = await ctx.terminal.open({ threadId: thread.id }, 80, 24)
    const second = await ctx.terminal.open({ threadId: thread.id }, 120, 40)

    expect(second.id).not.toBe(first.id)
    // 新开一个不会关掉前一个：底部终端的每个标签各有自己的 shell。
    expect(pty.killCount).toBe(0)
    expect(pty.spawns.map((input) => [input.cols, input.rows])).toEqual([
      [80, 24],
      [120, 40],
    ])
    expect(first.shell).toBe(shellName(defaultShell()))
    expect(first.cwd).toBe(pty.spawns[0]?.cwd)
    ctx.terminal.write(first.id, "one\n")
    ctx.terminal.write(second.id, "two\n")
    expect(pty.writes).toEqual(["one\n", "two\n"])
  })

  it("tells subscribers when the shell exits by itself, not when it is closed", async () => {
    const pty = fakePty()
    const { ctx, thread } = await setupTerminal(pty)
    const closed = await ctx.terminal.open({ threadId: thread.id }, 80, 24)
    const exits: number[] = []
    ctx.terminal.subscribe(
      closed.id,
      () => undefined,
      (code) => exits.push(code),
    )
    ctx.terminal.close(closed.id)
    expect(exits).toEqual([])

    const exited = await ctx.terminal.open({ threadId: thread.id }, 80, 24)
    ctx.terminal.subscribe(
      exited.id,
      () => undefined,
      (code) => exits.push(code),
    )
    pty.exit(130)
    expect(exits).toEqual([130])
  })

  it("names shells by their executable", () => {
    expect(shellName("/bin/zsh")).toBe("zsh")
    expect(shellName("/opt/homebrew/bin/fish")).toBe("fish")
    expect(shellName("C:\\Windows\\System32\\cmd.exe")).toBe("cmd")
  })

  it("cleans up after the pty exits", async () => {
    const pty = fakePty()
    const { ctx, thread } = await setupTerminal(pty)
    const opened = await ctx.terminal.open({ threadId: thread.id }, 80, 24)

    pty.exit(0)

    expect(() => ctx.terminal.write(opened.id, "after-exit")).toThrow("terminal not found")
    // 退出后同一线程可以重新打开终端。
    const reopened = await ctx.terminal.open({ threadId: thread.id }, 80, 24)
    expect(reopened.id).not.toBe(opened.id)
  })

  it("resolves cwd from the active worktree", async () => {
    const pty = fakePty()
    const { ctx, project, thread } = await setupTerminal(pty)
    const worktree = await mkdtemp(join(tmpdir(), "pigcode-terminal-worktree-"))
    roots.push(worktree)
    ctx.storage.db
      .prepare(
        `INSERT INTO worktrees
         (id, project_id, thread_id, path, branch, status, created_at, removed_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, NULL)`,
      )
      .run("wt_test", project.id, thread.id, worktree, "pigcode/test", new Date().toISOString())

    await ctx.terminal.open({ threadId: thread.id }, 80, 24)

    expect(pty.spawns[0]?.cwd).toBe(await realpath(worktree))
  })

  it("closes all of a thread's terminals and leaves other threads' alone", async () => {
    const pty = fakePty()
    const { ctx, thread, project } = await setupTerminal(pty)
    const other = ctx.threads.create(project.id, "Other", "fake")
    await ctx.terminal.open({ threadId: thread.id }, 80, 24)
    await ctx.terminal.open({ threadId: thread.id }, 80, 24)
    const kept = await ctx.terminal.open({ threadId: other.id }, 80, 24)

    ctx.terminal.closeThread(thread.id)
    expect(pty.killCount).toBe(2)
    expect(() => ctx.terminal.write(kept.id, "x")).not.toThrow()
    // 线程没有终端时什么也不做：归档会对每个线程都调用它。
    ctx.terminal.closeThread(thread.id)
    expect(pty.killCount).toBe(2)
  })

  it("opens a terminal in a project's root before there is a thread", async () => {
    const pty = fakePty()
    const { ctx, project, root } = await setupTerminal(pty)

    const opened = await ctx.terminal.open({ projectId: project.id }, 90, 30)

    // 新会话草稿里开的终端：没有会话，开在项目根目录。
    expect(opened).toMatchObject({
      threadId: null,
      projectId: project.id,
      cwd: await realpath(root),
    })
    expect(pty.spawns[0]).toMatchObject({ cwd: await realpath(root), cols: 90, rows: 30 })
    // 归档哪个会话都不会关它；会话里开的终端带着会话的项目。
    const thread = ctx.threads.create(project.id, "Later", "fake")
    const inThread = await ctx.terminal.open({ threadId: thread.id }, 80, 24)
    expect(inThread).toMatchObject({ threadId: thread.id, projectId: project.id })
    ctx.terminal.closeThread(thread.id)
    expect(pty.killCount).toBe(1)
    expect(() => ctx.terminal.write(opened.id, "x")).not.toThrow()
  })

  it("closes every terminal of a removed project, drafts' and threads' alike", async () => {
    const pty = fakePty()
    const { ctx, project, thread } = await setupTerminal(pty)
    const otherRoot = await mkdtemp(join(tmpdir(), "pigcode-terminal-other-"))
    roots.push(otherRoot)
    const other = ctx.projects.add(otherRoot)
    const draft = await ctx.terminal.open({ projectId: project.id }, 80, 24)
    const inThread = await ctx.terminal.open({ threadId: thread.id }, 80, 24)
    const kept = await ctx.terminal.open({ projectId: other.id }, 80, 24)

    ctx.terminal.closeProject(project.id)

    expect(pty.killCount).toBe(2)
    expect(() => ctx.terminal.write(draft.id, "x")).toThrow("terminal not found")
    expect(() => ctx.terminal.write(inThread.id, "x")).toThrow("terminal not found")
    expect(() => ctx.terminal.write(kept.id, "x")).not.toThrow()
  })

  it("refuses a project that is missing or was removed from the sidebar", async () => {
    const pty = fakePty()
    const { ctx, project } = await setupTerminal(pty)
    await expect(ctx.terminal.open({ projectId: "proj_missing" }, 80, 24)).rejects.toThrow(
      "project not found",
    )
    ctx.projects.remove(project.id)
    await expect(ctx.terminal.open({ projectId: project.id }, 80, 24)).rejects.toThrow(
      "project not found",
    )
    expect(pty.spawns).toEqual([])
  })

  it("rejects unknown threads and terminals", async () => {
    const pty = fakePty()
    const { ctx } = await setupTerminal(pty)

    await expect(ctx.terminal.open({ threadId: "th_missing" }, 80, 24)).rejects.toThrow(
      "thread not found",
    )
    expect(() => ctx.terminal.write("term_missing", "x")).toThrow("terminal not found")
    expect(() => ctx.terminal.resize("term_missing", 80, 24)).toThrow("terminal not found")
    expect(() => ctx.terminal.close("term_missing")).toThrow("terminal not found")
  })

  it("lists active terminals by creation order, thread, or draft project with live metadata", async () => {
    const pty = fakePty()
    const { ctx, project, thread } = await setupTerminal(pty)
    const otherThread = ctx.threads.create(project.id, "Other", "fake")

    const draft = await ctx.terminal.open({ projectId: project.id }, 80, 24, {
      placement: "drawer",
    })
    const first = await ctx.terminal.open({ threadId: thread.id }, 90, 25, {
      placement: "drawer",
    })
    const second = await ctx.terminal.open({ threadId: thread.id }, 100, 30, {
      placement: "workbench",
    })
    const third = await ctx.terminal.open({ threadId: otherThread.id }, 80, 24)

    expect(draft.cursor).toBe(0)
    expect(draft.placement).toBe("drawer")
    expect(Number.isNaN(Date.parse(draft.createdAt))).toBe(false)
    expect(third.placement).toBeUndefined()

    ctx.terminal.resize(first.id, 132, 42)
    pty.emit("hello", 1)

    expect(ctx.terminal.list().map((item) => item.id)).toEqual([
      draft.id,
      first.id,
      second.id,
      third.id,
    ])
    expect(ctx.terminal.list({ threadId: thread.id })).toEqual([
      expect.objectContaining({
        id: first.id,
        cols: 132,
        rows: 42,
        cursor: 5,
        placement: "drawer",
      }),
      expect.objectContaining({
        id: second.id,
        cols: 100,
        rows: 30,
        cursor: 0,
        placement: "workbench",
      }),
    ])
    expect(ctx.terminal.list({ projectId: project.id }).map((item) => item.id)).toEqual([draft.id])

    ctx.terminal.close(second.id)
    expect(ctx.terminal.list({ threadId: thread.id }).map((item) => item.id)).toEqual([first.id])
  })

  it("rebinds a draft terminal to a thread in the same project and rejects cross-project rebinds", async () => {
    const pty = fakePty()
    const { ctx, project, thread } = await setupTerminal(pty)
    const otherRoot = await mkdtemp(join(tmpdir(), "pigcode-terminal-rebind-"))
    roots.push(otherRoot)
    const otherProject = ctx.projects.add(otherRoot)
    const otherThread = ctx.threads.create(otherProject.id, "Other Project", "fake")
    const secondThread = ctx.threads.create(project.id, "Same Project 2", "fake")

    const draft = await ctx.terminal.open({ projectId: project.id }, 80, 24, {
      placement: "drawer",
    })
    expect(ctx.terminal.list({ projectId: project.id }).map((item) => item.id)).toEqual([draft.id])
    expect(ctx.terminal.list({ threadId: thread.id })).toEqual([])

    expect(() => ctx.terminal.rebind(draft.id, "th_missing")).toThrow("thread not found")
    expect(() => ctx.terminal.rebind(draft.id, otherThread.id)).toThrow(/project/i)
    expect(() => ctx.terminal.rebind("term_missing", thread.id)).toThrow("terminal not found")

    const rebound = ctx.terminal.rebind(draft.id, thread.id)
    expect(rebound).toMatchObject({ id: draft.id, threadId: thread.id, projectId: project.id })
    expect(ctx.terminal.list({ projectId: project.id })).toEqual([])
    expect(ctx.terminal.list({ threadId: thread.id }).map((item) => item.id)).toEqual([draft.id])

    // 幂等改绑同一线程允许；跨线程抢占拒绝。
    expect(ctx.terminal.rebind(draft.id, thread.id).threadId).toBe(thread.id)
    expect(() => ctx.terminal.rebind(draft.id, secondThread.id)).toThrow(/already bound/i)

    // 改绑后归档/关闭该线程能够正确关闭这个终端。
    ctx.terminal.closeThread(thread.id)
    expect(pty.killCount).toBe(1)
  })

  it("replays full and incremental scrollback on attach with zero overlap or gap", async () => {
    const pty = fakePty()
    const { ctx, thread } = await setupTerminal(pty)
    const opened = await ctx.terminal.open({ threadId: thread.id }, 80, 24)
    ctx.terminal.resize(opened.id, 110, 36)

    pty.emit("line1\n")
    pty.emit("line2\n")

    const live: Array<{ data: string; cursor: number }> = []
    const exits: number[] = []
    const firstAttach = ctx.terminal.attach(
      opened.id,
      (data, cursor) => live.push({ data, cursor }),
      (code) => exits.push(code),
    )
    expect(firstAttach.replay).toBe("line1\nline2\n")
    expect(firstAttach.cursor).toBe(12)
    expect(firstAttach.truncated).toBe(false)
    expect(firstAttach.session).toMatchObject({ cols: 110, rows: 36, cursor: 12 })

    // attach 后新输出只通过 live 回调到达，且 cursor 连续递增。
    pty.emit("line3\n")
    expect(live).toEqual([{ data: "line3\n", cursor: 18 }])
    firstAttach.unsubscribe()

    // 增量重放：从分片内部游标切出剩余部分，无重复无遗漏。
    const incremental = ctx.terminal.attach(opened.id, () => undefined, undefined, 3)
    expect(incremental.replay).toBe("e1\nline2\nline3\n")
    expect(incremental.cursor).toBe(18)
    expect(incremental.truncated).toBe(false)
    incremental.unsubscribe()

    // 游标已经在最新位置时重放为空串。
    const caughtUp = ctx.terminal.attach(opened.id, () => undefined, undefined, 18)
    expect(caughtUp.replay).toBe("")
    expect(caughtUp.cursor).toBe(18)
    expect(caughtUp.truncated).toBe(false)
    caughtUp.unsubscribe()

    // 非法游标抛错。
    expect(() => ctx.terminal.attach(opened.id, () => undefined, undefined, -1)).toThrow(
      /cursor/i,
    )
    expect(() => ctx.terminal.attach(opened.id, () => undefined, undefined, 1.5)).toThrow(
      /cursor/i,
    )

    // 退出事件正常触达仍在监听的订阅者。
    const onExitAttach = ctx.terminal.attach(opened.id, () => undefined, (code) => exits.push(code))
    pty.exit(42)
    expect(exits).toEqual([42])
    onExitAttach.unsubscribe()
  })

  it("evicts oldest chunks beyond scrollbackBytes and preserves UTF-16 surrogate pairs on oversize chunks", async () => {
    const pty = fakePty()
    const { ctx, thread } = await setupTerminal(pty, { scrollbackBytes: 8 })
    const opened = await ctx.terminal.open({ threadId: thread.id }, 80, 24)

    pty.emit("aaaa") // [0, 4) -> 4B
    pty.emit("bbbb") // [4, 8) -> 8B
    pty.emit("cccc") // [8, 12) -> 丢弃 aaaa，保留 bbbbcccc (8B)，startCursor = 4

    const fromZero = ctx.terminal.attach(opened.id, () => undefined, undefined, 0)
    expect(fromZero.replay).toBe("bbbbcccc")
    expect(fromZero.cursor).toBe(12)
    expect(fromZero.truncated).toBe(true)
    fromZero.unsubscribe()

    const fromStart = ctx.terminal.attach(opened.id, () => undefined, undefined, 4)
    expect(fromStart.replay).toBe("bbbbcccc")
    expect(fromStart.truncated).toBe(false)
    fromStart.unsubscribe()

    // 单片超过 8 字节上限：包含 4 字节 emoji（2 UTF-16 码元）与 ASCII。
    // "xy😀z" = 1 + 1 + 4 + 1 = 7B；"abcdef😀z" = 6 + 4 + 1 = 11B > 8B
    // 末尾最多保留 8B：'z'(1B) + '😀'(4B) + 'f'(1B) + 'e'(1B) + 'd'(1B) = 8B => "def😀z"
    pty.emit("abcdef😀z") // 原长度 9（a..f 6 + 😀 2 + z 1），endCursor = 21
    const afterEmoji = ctx.terminal.attach(opened.id, () => undefined, undefined, 0)
    expect(afterEmoji.replay).toBe("def😀z")
    expect(afterEmoji.cursor).toBe(21)
    expect(afterEmoji.truncated).toBe(true)
    expect(Buffer.byteLength(afterEmoji.replay, "utf8")).toBeLessThanOrEqual(8)
    afterEmoji.unsubscribe()

    // 再测试刚好卡在 emoji 中间字节的情况：
    // "0123😀4567" = 4 + 4 + 4 = 12B > 8B；末尾 8B 应该是 "😀4567" (4 + 4 = 8B)
    // 而 "0123😀45678" = 4 + 4 + 5 = 13B > 8B；末尾 5B 是 "45678"，再加 emoji 会变成 9B > 8B，
    // 因此必须跳过整个 emoji，只保留 "45678"，不能切裂代理对产生孤立低代理！
    pty.emit("0123😀45678") // length = 4 + 2 + 5 = 11，endCursor = 32
    const boundary = ctx.terminal.attach(opened.id, () => undefined, undefined, 0)
    expect(boundary.replay).toBe("45678")
    expect(boundary.cursor).toBe(32)
    expect(boundary.truncated).toBe(true)
    // 确保不包含孤立代理码元
    for (let i = 0; i < boundary.replay.length; i += 1) {
      const code = boundary.replay.charCodeAt(i)
      expect(code < 0xd800 || code > 0xdfff).toBe(true)
    }
    boundary.unsubscribe()

    // 增量重放游标若落在代理对中间（如 "😀a" 偏移 1），也不切裂代理对。
    pty.emit("😀a") // [32, 35)，其中 32 是高代理、33 是低代理、34 是 'a'
    const midSurrogate = ctx.terminal.attach(opened.id, () => undefined, undefined, 33)
    expect(midSurrogate.replay).toBe("a")
    expect(midSurrogate.cursor).toBe(35)
    midSurrogate.unsubscribe()
  })
})
