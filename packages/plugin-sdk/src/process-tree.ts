/**
 * 启动和结束一整棵进程树。CLI 跑工具时会再启动子进程，只结束 CLI 本身可能把它们留下来。
 * POSIX 上让子进程自成一个进程组，向组发信号；Windows 没有进程组，用 taskkill /T 按父子关系结束。
 */
import { execFile, type ChildProcess } from "node:child_process"
import {
  forgetProcessTree,
  processRecordIntervalMs,
  recordProcessTree,
  startProcessTree,
} from "./process-records"

/**
 * 优雅终止后等多久再强制结束。要给 CLI 留出退出前的工作（Claude Code 的 SessionEnd hook 等），
 * 又不能太长：Host 退出时 main 只等 HOST_STOP_TIMEOUT_MS。
 */
const DEFAULT_GRACE_MS = 3000
const POLL_MS = 25
/** 读进程表的最长时间。 */
const PS_TIMEOUT_MS = 1000
const IS_WINDOWS = process.platform === "win32"

/** 展开到 spawn 的选项里。Windows 上 detached 会弹出新的控制台窗口，所以只在 POSIX 上用。 */
export const PROCESS_TREE_SPAWN_OPTIONS = { detached: !IS_WINDOWS, windowsHide: true } as const

export interface TerminateOptions {
  /** 先发的信号；默认 SIGTERM。交互式 shell 忽略 SIGTERM，要发 SIGHUP。Windows 上没有优雅阶段。 */
  signal?: NodeJS.Signals
  graceMs?: number
}

/** 向进程组发信号；组已经不存在时返回 false。 */
function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal)
    return true
  } catch {
    return false
  }
}

/** taskkill 失败通常是进程已经退出，没有需要处理的。 */
function taskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true }, () => resolve())
  })
}

/** pid 0 和 1 在 POSIX 上取负后分别表示自己所在的组和所有进程，绝不能发信号。 */
function isSignalable(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1
}

/** 向几个组发信号，组还在就等到超时，然后强制结束。 */
async function endGroups(groups: number[], options: TerminateOptions): Promise<void> {
  let remaining = groups.filter((pgid) => signalGroup(pgid, options.signal ?? "SIGTERM"))
  const deadline = Date.now() + (options.graceMs ?? DEFAULT_GRACE_MS)
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    remaining = remaining.filter((pgid) => signalGroup(pgid, 0))
  }
  for (const pgid of remaining) signalGroup(pgid, "SIGKILL")
}

/** 把 ps 的输出解析成行；空行缺列，会被丢掉。 */
function parseProcessTable(stdout: string): Array<{ pid: number; ppid: number; pgid: number }> {
  return stdout.split("\n").flatMap((line) => {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number)
    return pid !== undefined && ppid !== undefined && pgid !== undefined
      ? [{ pid, ppid, pgid }]
      : []
  })
}

/**
 * 读进程表：pid、ppid、pgid 各一列。分开写 -o：写在一起时第一个 = 之后都会被当成列标题。
 * 读不到（内存耗尽时 spawn 会直接抛错）或卡住时返回空表：信号要等它才发，它不能挡住结束进程。
 */
function readProcessTable(): Promise<Array<{ pid: number; ppid: number; pgid: number }>> {
  return new Promise((resolve) => {
    try {
      execFile(
        "ps",
        ["-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid="],
        { timeout: PS_TIMEOUT_MS, killSignal: "SIGKILL" },
        (error, stdout) => resolve(error ? [] : parseProcessTable(stdout)),
      )
    } catch {
      resolve([])
    }
  })
}

/**
 * 后代进程所在的组。Claude Code 把每条 Bash 命令放在独立的 session 里，向 CLI 的组发信号到不了它们，
 * 只能趁父子关系还在时从进程表里找出来。CLI 一退出，这些进程就没法再找到了。
 * 代价是：一轮刚结束、CLI 还没退出时结束会话，这一轮有意留下的 dev server 也会被结束；这个窗口很短。
 */
async function descendantGroups(root: number): Promise<number[]> {
  const table = await readProcessTable()
  const ownGroup = table.find((row) => row.pid === process.pid)?.pgid
  const seen = new Set([root])
  const groups = new Set<number>()
  for (let frontier = [root]; frontier.length > 0;) {
    const children = table.filter((row) => frontier.includes(row.ppid) && !seen.has(row.pid))
    for (const child of children) {
      seen.add(child.pid)
      if (isSignalable(child.pgid) && child.pgid !== ownGroup) groups.add(child.pgid)
    }
    frontier = children.map((child) => child.pid)
  }
  return [...groups]
}

/**
 * 结束进程和它所有的后代，包括搬到别的 session 里的。pid 必须是用 PROCESS_TREE_SPAWN_OPTIONS 启动的进程。
 * 用户在终端里 nohup 的进程不该被这样结束，那里用 terminateProcessGroup。
 */
export async function terminateProcessTree(
  pid: number,
  options: TerminateOptions = {},
): Promise<void> {
  if (!isSignalable(pid)) return
  if (IS_WINDOWS) return taskkill(pid)
  await endGroups([...new Set([pid, ...(await descendantGroups(pid))])], options)
}

/** 只结束 pid 所在的进程组，不找搬出去的后代。pid 必须是组长。Windows 上没有进程组，结束整棵树。 */
export async function terminateProcessGroup(
  pid: number,
  options: TerminateOptions = {},
): Promise<void> {
  if (!isSignalable(pid)) return
  if (IS_WINDOWS) return taskkill(pid)
  await endGroups([pid], options)
}

/** 一棵属于我们的进程树；结束之后 pid 可能被系统复用，所以不再向它发任何信号。 */
export interface OwnedProcessTree {
  /** 向整棵树发信号；树已经结束或开始结束时返回 false。 */
  signal(signal: NodeJS.Signals): boolean
  /** 结束整棵树；多次调用共用同一次结束，等得到它真正结束。 */
  terminate(options?: TerminateOptions): Promise<void>
}

/**
 * 接管用 PROCESS_TREE_SPAWN_OPTIONS 启动的子进程。它崩溃时清理组里剩下的进程；搬到别的 session 里的
 * 工具进程这时已经找不到了，由下次启动时的清理负责（pigcode/pigcode#47）。
 * 正常退出时不动：Claude Code 每轮结束都会退出，agent 这一轮可能有意留下 dev server。
 * Windows 上它一退出，父子关系就查不到了，没有可清理的。
 */
export function ownProcessTree(child: ChildProcess): OwnedProcessTree {
  const pid = child.pid
  let termination: Promise<void> | undefined
  // 记下这棵树的进程和启动时间：Host 如果崩溃，下次启动时靠它收拾（pigcode/pigcode#47）。
  const intervalMs = processRecordIntervalMs()
  const timer =
    pid !== undefined && intervalMs > 0
      ? setInterval(() => void recordProcessTree(pid), intervalMs)
      : undefined
  timer?.unref()
  if (pid !== undefined && processRecordIntervalMs() > 0) {
    startProcessTree(pid)
    void recordProcessTree(pid)
  }
  const terminate = (options?: TerminateOptions): Promise<void> => {
    termination ??= pid === undefined ? Promise.resolve() : terminateProcessTree(pid, options)
    return termination
  }
  child.once("exit", (code, signal) => {
    if (!IS_WINDOWS && (code !== 0 || signal !== null)) void terminate()
    else termination ??= Promise.resolve()
    if (timer) clearInterval(timer)
    if (pid !== undefined) forgetProcessTree(pid)
  })
  return {
    signal(signal) {
      if (pid === undefined || termination || !isSignalable(pid)) return false
      if (!IS_WINDOWS) return signalGroup(pid, signal)
      void terminate()
      return true
    },
    terminate,
  }
}
