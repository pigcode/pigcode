/** 用真实 PTY 和 bash 验证：关闭终端时，shell 里跑着的进程一起结束。 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "cordis"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { apply as projects } from "./projects"
import { apply as storage } from "./storage"
import { apply as terminal } from "./terminal"
import { apply as threads } from "./threads"

const contexts: Context[] = []
const roots: string[] = []
const pids: number[] = []
const shell = process.env.SHELL

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function openShell() {
  const root = await mkdtemp(join(tmpdir(), "pigcode-terminal-real-"))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(terminal)
  const project = ctx.projects.add(root)
  const thread = ctx.threads.create(project.id, "Terminal", "fake")
  const session = await ctx.terminal.open(thread.id, 80, 24)
  let output = ""
  ctx.terminal.subscribe(session.id, (data) => {
    output += data
  })
  /** 运行命令，等它把 pid 打印成 <label>:<pid>:END。 */
  const runForPid = async (command: string, label: string): Promise<number> => {
    ctx.terminal.write(session.id, `${command}\n`)
    const pattern = new RegExp(`${label}:(\\d+):END`)
    const pid = await vi.waitFor(
      () => {
        const match = pattern.exec(output)
        if (!match?.[1]) throw new Error(`no ${label} yet: ${output}`)
        return Number(match[1])
      },
      { timeout: 10000, interval: 25 },
    )
    pids.push(pid)
    return pid
  }
  return { ctx, session, runForPid }
}

// 用 jobs -p 取 pid：交互式 bash 会把 $!:E 当成历史修饰符。
const BACKGROUND = "sleep 98765 & jobs -p | sed 's/^/BG:/; s/$/:END/'"
const FOREGROUND = `bash -c 'echo FG:$$:END; exec sleep 98766'`

describe.skipIf(process.platform === "win32")("real terminal processes", { timeout: 30000 }, () => {
  beforeEach(() => {
    // 用户的登录 shell 可能是 fish，下面的命令是 bash 语法；bash 也是收到 SIGHUP 时转发给作业的那种 shell。
    process.env.SHELL = "/bin/bash"
  })

  afterEach(async () => {
    process.env.SHELL = shell
    await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
    for (const pid of pids.splice(0)) if (isAlive(pid)) process.kill(pid, "SIGKILL")
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
    )
  })

  it("ends background and foreground jobs when the terminal closes", async () => {
    const { ctx, session, runForPid } = await openShell()
    const background = await runForPid(BACKGROUND, "BG")
    const foreground = await runForPid(FOREGROUND, "FG")
    expect(isAlive(background)).toBe(true)
    expect(isAlive(foreground)).toBe(true)

    ctx.terminal.close(session.id)
    await vi.waitFor(
      () => {
        expect(isAlive(background)).toBe(false)
        expect(isAlive(foreground)).toBe(false)
      },
      { timeout: 5000, interval: 25 },
    )
  })

  it("ends them before disposing finishes, so Host can exit right after", async () => {
    const { ctx, runForPid } = await openShell()
    const background = await runForPid(BACKGROUND, "BG")
    const foreground = await runForPid(FOREGROUND, "FG")

    await ctx.fiber.dispose()
    // 进程结束后到被系统回收还有一瞬间，所以仍然轮询；但比宽限期（3 秒）短得多，超过了就是没等到清理。
    await vi.waitFor(
      () => {
        expect(isAlive(background)).toBe(false)
        expect(isAlive(foreground)).toBe(false)
      },
      { timeout: 1500, interval: 25 },
    )
  })
})
