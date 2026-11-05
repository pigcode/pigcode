/**
 * 记下 Host 启动的 Agent 进程，下次 Host 起来时把上个 Host 崩溃留下的它们收拾掉。
 * pid 会被系统复用，所以同时记启动时间，只有时间和 pid 都对得上才结束。
 */
import { execFile } from "node:child_process"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/** 一条记录：某个 Agent 进程树里的一个进程。 */
interface ProcessRecord {
  pid: number
  /** `ps -o lstart` 的原文；同一个进程每次都一样。 */
  startedAt: string
  /** 这棵树从哪个 pid 长出来的，也就是 CLI 自己。 */
  root: number
}

/** 树里每个进程的启动时间；每隔一段时间刷新一次，CLI 崩溃前启动的工具才留得下记录。 */
const recorded = new Map<number, Map<number, string>>()

/**
 * 已经结束、不再记录的树。定时快照可能在「删除记录」之后才从 ps 回来，没有它会把刚删掉的记录写回去。
 * 同一个 pid 被新进程复用时由 startProcessTree 清掉。
 */
const forgotten = new Set<number>()

/** 默认多久刷新一次；测试用 PIGCODE_PROCESS_RECORD_MS 缩短。 */
const DEFAULT_INTERVAL_MS = 5000

/** 记录文件放在 profile 目录里；没有这个目录（单元测试、CLI 冒烟）时不记录。 */
function recordFile(): string | undefined {
  const dir = process.env.PIGCODE_PROFILE_DIR
  return dir ? join(dir, "agent-processes.json") : undefined
}

/** 记录间隔；设成 0 表示不记录。 */
export function processRecordIntervalMs(): number {
  const raw = process.env.PIGCODE_PROCESS_RECORD_MS
  const value = raw === undefined ? DEFAULT_INTERVAL_MS : Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_INTERVAL_MS
}

/** 把当前所有树的记录写回文件。写不进去不影响运行，下次启动只是少清理一个进程。 */
function flush(): void {
  const path = recordFile()
  if (!path) return
  const records: ProcessRecord[] = [...recorded].flatMap(([root, pids]) =>
    [...pids].map(([pid, startedAt]) => ({ pid, startedAt, root })),
  )
  const tmp = `${path}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, JSON.stringify(records))
    renameSync(tmp, path)
  } catch {
    // 忽略：清理是尽力而为。
  }
}

/** 读进程表：pid、ppid、启动时间。启动时间放在最后，它自己带空格。 */
function readTable(): Promise<Array<{ pid: number; ppid: number; startedAt: string }>> {
  return new Promise((resolve) => {
    try {
      execFile(
        "ps",
        ["-A", "-o", "pid=", "-o", "ppid=", "-o", "lstart="],
        { timeout: 1000, killSignal: "SIGKILL" },
        (error, stdout) => {
          if (error) {
            resolve([])
            return
          }
          const rows = stdout.split("\n").flatMap((line) => {
            const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
            return match
              ? [{ pid: Number(match[1]), ppid: Number(match[2]), startedAt: match[3]! }]
              : []
          })
          resolve(rows)
        },
      )
    } catch {
      resolve([])
    }
  })
}

/** 一个进程的启动时间；进程不在了或查不到时返回 undefined。 */
export async function processStartTime(pid: number): Promise<string | undefined> {
  const table = await readTable()
  return table.find((row) => row.pid === pid)?.startedAt
}

/** 刷新一棵树的记录：CLI 自己和它当前的所有后代。 */
export async function recordProcessTree(root: number): Promise<void> {
  if (process.platform === "win32" || !recordFile() || root <= 1) return
  const table = await readTable()
  // 读进程表期间这棵树可能已经结束并删过记录，这时不能再写回去。
  if (forgotten.has(root)) return
  const pids = new Map<number, string>()
  const start = table.find((row) => row.pid === root)?.startedAt
  if (start === undefined) return
  pids.set(root, start)
  const seen = new Set([root])
  for (let frontier = [root]; frontier.length > 0;) {
    const children = table.filter((row) => frontier.includes(row.ppid) && !seen.has(row.pid))
    for (const child of children) {
      seen.add(child.pid)
      pids.set(child.pid, child.startedAt)
    }
    frontier = children.map((child) => child.pid)
  }
  recorded.set(root, pids)
  flush()
}

/** 一棵树开始记录：如果这个 pid 上次已经结束过，清掉标记。 */
export function startProcessTree(root: number): void {
  forgotten.delete(root)
}

/** 这棵树已经结束：不再记它。 */
export function forgetProcessTree(root: number): void {
  forgotten.add(root)
  if (recorded.delete(root)) flush()
}

/**
 * 上次 Host 崩溃时留下的进程：pid 和启动时间都对得上才结束，然后清空记录。
 * Windows 上查不到可靠的启动时间，不清理，免得结束一个复用了 pid 的无关进程。
 */
export async function sweepOrphanedProcesses(): Promise<number> {
  const path = recordFile()
  if (!path || process.platform === "win32") return 0
  let stale: ProcessRecord[]
  try {
    stale = JSON.parse(readFileSync(path, "utf8")) as ProcessRecord[]
  } catch {
    return 0
  }
  const table = await readTable()
  const alive = new Map(table.map((row) => [row.pid, row.startedAt]))
  const { terminateProcessTree } = await import("./process-tree")
  let killed = 0
  for (const { pid, startedAt } of stale) {
    if (alive.get(pid) !== startedAt) continue
    await terminateProcessTree(pid)
    killed += 1
  }
  recorded.clear()
  flush()
  return killed
}
