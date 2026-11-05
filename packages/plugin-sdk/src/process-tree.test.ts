/** 用真实进程验证：结束一个子进程时，它启动的孙进程也一起结束。 */
import { spawn, type ChildProcessByStdio } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import type { Readable } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ownProcessTree, PROCESS_TREE_SPAWN_OPTIONS, terminateProcessTree } from "./process-tree"

const posixIt = it.skipIf(process.platform === "win32")

/** 永远不退出的孙进程；stdio 全部断开，父进程结束后它不会因为管道关闭而退出。 */
const GRANDCHILD = (ignoreTerm: boolean): string =>
  `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ""}setInterval(() => {}, 1000)`

/** 子进程脚本：启动孙进程，把它的 pid 打印出来；之后的行为由 after 决定。 */
function parentScript(
  options: { ignoreTerm?: boolean; detached?: boolean; after?: string } = {},
): string {
  const grandchild = GRANDCHILD(options.ignoreTerm === true)
  return `
    const { spawn } = require("node:child_process")
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore", detached: ${options.detached === true} })
    ${options.ignoreTerm ? "process.on('SIGTERM', () => {})" : ""}
    setTimeout(() => {
      console.log(child.pid)
      ${options.after ?? "setInterval(() => {}, 1000)"}
    }, 200)
  `
}

const leftovers: number[] = []

/** 启动脚本并等它报告孙进程的 pid。 */
async function start(script: string): Promise<{
  child: ChildProcessByStdio<null, Readable, null>
  grandchildPid: number
}> {
  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "ignore"],
    ...PROCESS_TREE_SPAWN_OPTIONS,
  })
  const line = await new Promise<string>((resolve, reject) => {
    child.once("error", reject)
    createInterface({ input: child.stdout }).once("line", resolve)
  })
  const grandchildPid = Number(line)
  leftovers.push(child.pid ?? 0, grandchildPid)
  return { child, grandchildPid }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 进程退出后系统回收需要一点时间，所以轮询。 */
async function expectGone(pid: number): Promise<void> {
  await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 5000, interval: 25 })
}

afterEach(() => {
  for (const pid of leftovers.splice(0)) {
    if (pid > 1 && isAlive(pid)) process.kill(pid, "SIGKILL")
  }
})

describe("terminateProcessTree", () => {
  it("ends the process and the processes it started", async () => {
    const { child, grandchildPid } = await start(parentScript())
    expect(isAlive(grandchildPid)).toBe(true)
    await terminateProcessTree(child.pid ?? 0)
    await expectGone(child.pid ?? 0)
    await expectGone(grandchildPid)
  })

  posixIt(
    "force-kills whatever ignores the polite signal once the grace period is over",
    async () => {
      const { child, grandchildPid } = await start(parentScript({ ignoreTerm: true }))
      await terminateProcessTree(child.pid ?? 0, { graceMs: 100 })
      await expectGone(child.pid ?? 0)
      await expectGone(grandchildPid)
    },
  )

  // Claude Code 把 Bash 工具放在独立的 session 里，向 CLI 的组发信号到不了它们。
  it("reaches a descendant that moved to its own session", async () => {
    const { child, grandchildPid } = await start(parentScript({ detached: true }))
    await terminateProcessTree(child.pid ?? 0)
    await expectGone(child.pid ?? 0)
    await expectGone(grandchildPid)
  })

  posixIt(
    "force-kills a descendant in its own session that ignores the polite signal",
    async () => {
      const { child, grandchildPid } = await start(
        parentScript({ detached: true, ignoreTerm: true }),
      )
      await terminateProcessTree(child.pid ?? 0, { graceMs: 100 })
      await expectGone(child.pid ?? 0)
      await expectGone(grandchildPid)
    },
  )

  describe("when ps misbehaves", () => {
    const path = process.env.PATH

    afterEach(() => {
      process.env.PATH = path
    })

    posixIt("still ends the process when ps cannot be started", async () => {
      const { child } = await start(parentScript())
      process.env.PATH = "/nonexistent"
      await terminateProcessTree(child.pid ?? 0)
      process.env.PATH = path
      await expectGone(child.pid ?? 0)
    })

    posixIt("still ends the process when ps hangs", async () => {
      const { child } = await start(parentScript())
      const bin = await mkdtemp(join(tmpdir(), "pigcode-hanging-ps-"))
      await writeFile(join(bin, "ps"), "#!/bin/sh\nexec /bin/sleep 30\n", { mode: 0o755 })
      process.env.PATH = `${bin}:${path ?? ""}`
      await terminateProcessTree(child.pid ?? 0)
      process.env.PATH = path
      await expectGone(child.pid ?? 0)
    })
  })

  posixIt(
    "never signals pid 0 or 1, which on POSIX mean our own group and every process",
    async () => {
      const kill = vi.spyOn(process, "kill")
      await terminateProcessTree(0)
      await terminateProcessTree(1)
      expect(kill).not.toHaveBeenCalled()
      kill.mockRestore()
    },
  )
})

describe("ownProcessTree", () => {
  it("terminates the whole tree", async () => {
    const { child, grandchildPid } = await start(parentScript())
    await ownProcessTree(child).terminate()
    await expectGone(child.pid ?? 0)
    await expectGone(grandchildPid)
  })

  posixIt("cleans up what is left when the process crashes", async () => {
    const { child, grandchildPid } = await start(
      parentScript({ after: "setTimeout(() => process.exit(1), 100)" }),
    )
    const tree = ownProcessTree(child)
    await expectGone(grandchildPid)
    await tree.terminate()
  })

  // 只在 POSIX 上有意义：Windows 上 libuv 的 Job 对象会在父进程退出时结束它的子进程，不是我们做的。
  posixIt(
    "leaves what the process started alone when it exits normally, and forgets its pid",
    async () => {
      const { child, grandchildPid } = await start(
        parentScript({ after: "setTimeout(() => process.exit(0), 100)" }),
      )
      const tree = ownProcessTree(child)
      await new Promise((resolve) => child.once("exit", resolve))
      const kill = vi.spyOn(process, "kill")
      await tree.terminate()
      expect(kill).not.toHaveBeenCalled()
      kill.mockRestore()
      expect(isAlive(grandchildPid)).toBe(true)
    },
  )

  posixIt(
    "does not signal again after the tree is gone, because the pid may belong to someone else by then",
    async () => {
      const { child } = await start(parentScript())
      const tree = ownProcessTree(child)
      await tree.terminate()
      await expectGone(child.pid ?? 0)
      const kill = vi.spyOn(process, "kill")
      await tree.terminate()
      expect(tree.signal("SIGTERM")).toBe(false)
      expect(kill).not.toHaveBeenCalled()
      kill.mockRestore()
    },
  )

  posixIt("has nothing to do when the process never started", async () => {
    const child = spawn("/nonexistent/pigcode-process-tree", [], { stdio: "ignore" })
    child.once("error", () => undefined)
    const kill = vi.spyOn(process, "kill")
    await ownProcessTree(child).terminate()
    expect(kill).not.toHaveBeenCalled()
    kill.mockRestore()
  })
})
