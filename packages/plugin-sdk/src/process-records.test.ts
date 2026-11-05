/** 验证 Agent 进程的记录，以及下次启动时按 pid 加启动时间清理遗留进程。 */
import { spawn, type ChildProcessByStdio } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import type { Readable } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  forgetProcessTree,
  processStartTime,
  recordProcessTree,
  sweepOrphanedProcesses,
} from "./process-records"
import { ownProcessTree, PROCESS_TREE_SPAWN_OPTIONS, type OwnedProcessTree } from "./process-tree"

const posixIt = it.skipIf(process.platform === "win32")

/** 子进程：起一个独立的孙进程，把它的 pid 打印出来，然后一直等着。 */
const SCRIPT = `
  const { spawn } = require("node:child_process")
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    detached: true,
  })
  setTimeout(() => console.log(child.pid), 200)
  setInterval(() => {}, 1000)
`

const dirs: string[] = []
const trees: OwnedProcessTree[] = []
const pids: number[] = []
const profileDir = process.env.PIGCODE_PROFILE_DIR
const recordMs = process.env.PIGCODE_PROCESS_RECORD_MS

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function profile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pigcode-records-"))
  dirs.push(dir)
  process.env.PIGCODE_PROFILE_DIR = dir
  return dir
}

function recordsPath(dir: string): string {
  return join(dir, "agent-processes.json")
}

async function readRecords(dir: string): Promise<Array<{ pid: number; startedAt: string }>> {
  return JSON.parse(await readFile(recordsPath(dir), "utf8")) as Array<{
    pid: number
    startedAt: string
  }>
}

/** 启动一棵树并等它报告孙进程的 pid；不立刻接管，由调用方决定用不用 ownProcessTree。 */
async function startTree(): Promise<{
  child: ChildProcessByStdio<null, Readable, null>
  grandchildPid: number
}> {
  const child = spawn(process.execPath, ["-e", SCRIPT], {
    stdio: ["ignore", "pipe", "ignore"],
    ...PROCESS_TREE_SPAWN_OPTIONS,
  })
  const line = await new Promise<string>((resolve, reject) => {
    child.once("error", reject)
    createInterface({ input: child.stdout }).once("line", resolve)
  })
  const grandchildPid = Number(line)
  pids.push(child.pid ?? 0, grandchildPid)
  return { child, grandchildPid }
}

afterEach(async () => {
  for (const tree of trees.splice(0)) await tree.terminate()
  for (const pid of pids.splice(0)) {
    if (pid <= 1 || !isAlive(pid)) continue
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      process.kill(pid, "SIGKILL")
    }
  }
  process.env.PIGCODE_PROFILE_DIR = profileDir
  process.env.PIGCODE_PROCESS_RECORD_MS = recordMs
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

// 这些用例要起真实进程、读进程表；整套测试并行跑时 5 秒不够。
describe("process records", { timeout: 30_000 }, () => {
  posixIt("records the CLI and the processes it started", async () => {
    const dir = await profile()
    const { child, grandchildPid } = await startTree()
    await recordProcessTree(child.pid ?? 0)
    const recorded = await readRecords(dir)
    expect(recorded.map((record) => record.pid)).toEqual(
      expect.arrayContaining([child.pid, grandchildPid]),
    )
  })

  posixIt("ends processes left by the last Host and clears the records", async () => {
    const dir = await profile()
    const { child, grandchildPid } = await startTree()
    // 上个 Host 会这样记下它们：pid 和当时的启动时间。
    await writeFile(
      recordsPath(dir),
      JSON.stringify([
        { pid: child.pid, startedAt: await processStartTime(child.pid ?? 0), root: child.pid },
        { pid: grandchildPid, startedAt: await processStartTime(grandchildPid), root: child.pid },
      ]),
    )

    expect(await sweepOrphanedProcesses()).toBe(2)
    await vi.waitFor(
      () => {
        expect(isAlive(child.pid ?? 0)).toBe(false)
        expect(isAlive(grandchildPid)).toBe(false)
      },
      { timeout: 5000, interval: 25 },
    )
    expect(await readRecords(dir)).toEqual([])
  })

  posixIt("leaves a process alone when the pid now belongs to something else", async () => {
    const dir = await profile()
    const { child, grandchildPid } = await startTree()
    // 启动时间对不上：这个 pid 已经被系统复用，不能碰。
    await writeFile(
      recordsPath(dir),
      JSON.stringify([
        { pid: grandchildPid, startedAt: "Thu Jan  1 00:00:00 1970", root: child.pid },
      ]),
    )

    expect(await sweepOrphanedProcesses()).toBe(0)
    expect(isAlive(grandchildPid)).toBe(true)
    expect(isAlive(child.pid ?? 0)).toBe(true)
  })

  posixIt(
    "forgets the tree when it ends, and the interval keeps its children on record",
    async () => {
      const dir = await profile()
      process.env.PIGCODE_PROCESS_RECORD_MS = "50"
      const { child, grandchildPid } = await startTree()
      const tree = ownProcessTree(child)
      trees.push(tree)

      await vi.waitFor(
        async () => {
          const recorded = await readRecords(dir).catch(() => [])
          expect(recorded.map((record) => record.pid)).toEqual(
            expect.arrayContaining([child.pid, grandchildPid]),
          )
        },
        { timeout: 5000, interval: 50 },
      )

      await tree.terminate()
      await vi.waitFor(async () => expect(await readRecords(dir)).toEqual([]), {
        timeout: 5000,
        interval: 25,
      })
      // 记下的数不会因为同一棵树反复快照而一直增长。
      forgetProcessTree(child.pid ?? 0)
    },
  )
})
