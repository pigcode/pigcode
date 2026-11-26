/** terminal 服务单测共享夹具：fake PTY 工厂与临时 Host。 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "cordis"
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
export interface FakePty {
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

/** 创建 fake PTY；write 会同步把转换后的输出广播回 data 监听器。 */
export function fakePty(transform: (data: string) => string = (data) => data): FakePty {
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

/** 等待异步条件成立；fake 输出是同步的，只用于保持与真实 PTY 一致。 */
export async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("condition not met")
}

/** 创建带自动清理的 terminal 服务测试夹具。 */
export function createTerminalHarness() {
  const contexts: Context[] = []
  const roots: string[] = []

  return {
    roots,
    /** 建立带 terminal 服务的内存 Host 与临时项目。 */
    async setup(pty: FakePty, options: { scrollbackBytes?: number } = {}) {
      const root = await mkdtemp(join(tmpdir(), "pigcode-terminal-"))
      roots.push(root)
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(storage, { path: ":memory:" })
      await ctx.plugin(projects)
      await ctx.plugin(threads)
      await ctx.plugin(terminal, {
        ptyFactory: pty.factory,
        ...(options.scrollbackBytes !== undefined
          ? { scrollbackBytes: options.scrollbackBytes }
          : {}),
      })
      const project = ctx.projects.add(root)
      const thread = ctx.threads.create(project.id, "Terminal", "fake")
      return { ctx, project, thread, root }
    },
    async cleanup() {
      await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
      await Promise.all(
        roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
      )
    },
  }
}
