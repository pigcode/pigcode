/** 用 fake PTY 工厂验证 open/write/output/resize/close，不加载原生模块。 */
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "cordis"
import { afterEach, describe, expect, it } from "vitest"
import { apply as projects } from "./projects"
import { apply as storage } from "./storage"
import { apply as terminal, type PtyFactory, type PtySpawnInput } from "./terminal"
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
  }
}

/** 建立带 terminal 服务的内存 Host 与临时项目。 */
async function setupTerminal(pty: FakePty) {
  const root = await mkdtemp(join(tmpdir(), "pigcode-terminal-"))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(terminal, { ptyFactory: pty.factory })
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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("terminal service", () => {
  it("echoes input and closes", async () => {
    const data: string[] = []
    const pty = fakePty((write) => `echo:${write}`)
    const { ctx, thread, root } = await setupTerminal(pty)

    const opened = await ctx.terminal.open(thread.id, 80, 24)
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

  it("keeps at most one terminal per thread", async () => {
    const pty = fakePty()
    const { ctx, thread } = await setupTerminal(pty)

    const first = await ctx.terminal.open(thread.id, 80, 24)
    const second = await ctx.terminal.open(thread.id, 120, 40)

    expect(second.id).not.toBe(first.id)
    expect(pty.killCount).toBe(1)
    expect(pty.spawns.map((input) => [input.cols, input.rows])).toEqual([
      [80, 24],
      [120, 40],
    ])
    expect(() => ctx.terminal.write(first.id, "stale")).toThrow("terminal not found")
    ctx.terminal.write(second.id, "ok\n")
    expect(pty.writes).toEqual(["ok\n"])
  })

  it("cleans up after the pty exits", async () => {
    const pty = fakePty()
    const { ctx, thread } = await setupTerminal(pty)
    const opened = await ctx.terminal.open(thread.id, 80, 24)

    pty.exit(0)

    expect(() => ctx.terminal.write(opened.id, "after-exit")).toThrow("terminal not found")
    // 退出后同一线程可以重新打开终端。
    const reopened = await ctx.terminal.open(thread.id, 80, 24)
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

    await ctx.terminal.open(thread.id, 80, 24)

    expect(pty.spawns[0]?.cwd).toBe(await realpath(worktree))
  })

  it("rejects unknown threads and terminals", async () => {
    const pty = fakePty()
    const { ctx } = await setupTerminal(pty)

    await expect(ctx.terminal.open("th_missing", 80, 24)).rejects.toThrow("thread not found")
    expect(() => ctx.terminal.write("term_missing", "x")).toThrow("terminal not found")
    expect(() => ctx.terminal.resize("term_missing", 80, 24)).toThrow("terminal not found")
    expect(() => ctx.terminal.close("term_missing")).toThrow("terminal not found")
  })
})
