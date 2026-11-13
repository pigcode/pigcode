/** Codex 子进程的 NDJSON 传输；测试用 replay 实现。 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import {
  launchTarget,
  ownProcessTree,
  PROCESS_TREE_SPAWN_OPTIONS,
  type OwnedProcessTree,
} from "@pigcode/plugin-sdk/node"

/** 退出原因里保留的 stderr 末尾长度。 */
const STDERR_TAIL_CHARS = 2000

/** 按行收发 NDJSON 的最小传输接口；协议层不感知进程与回放的区别。 */
export interface CodexTransport {
  send(line: string): void
  onLine(listener: (line: string) => void): () => void
  /** 子进程启动失败或退出时回调一次；回放传输可以不实现。 */
  onClose?(listener: (reason: Error) => void): () => void
  /** 返回的 Promise 在子进程和它启动的进程都结束后完成。 */
  close(): void | Promise<void>
}

/**
 * 通过 `codex app-server --stdio` 子进程收发 NDJSON。
 * 没装 Codex（spawn ENOENT）或进程退出都只通知 onClose，不能让未处理的 error 事件
 * 带崩整个 Host 进程。
 */
export class StdioCodexTransport implements CodexTransport {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly tree: OwnedProcessTree
  private readonly listeners = new Set<(line: string) => void>()
  private readonly closeListeners = new Set<(reason: Error) => void>()
  private closed: Error | null = null
  private stderrTail = ""

  constructor(
    command = "codex",
    args = ["app-server", "--stdio"],
    env: NodeJS.ProcessEnv | undefined = undefined,
  ) {
    // Windows 上 npm 装的 codex 是 .cmd；解析后直接启动它实际运行的 node 入口，
    // 用户给的启动参数就不会被 cmd 重新切分或展开。
    const target = launchTarget(command, args)
    this.child = spawn(target.command, target.args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(target.shell ? { shell: true } : {}),
      ...PROCESS_TREE_SPAWN_OPTIONS,
      ...(env ? { env } : {}),
    })
    this.tree = ownProcessTree(this.child)
    this.child.on("error", (error) =>
      this.finish(new Error(`codex app-server unavailable: ${error.message}`)),
    )
    this.child.on("exit", (code, signal) =>
      this.finish(
        new Error(
          withStderr(
            `codex app-server exited (${signal ?? `code ${String(code)}`})`,
            this.stderrTail,
          ),
        ),
      ),
    )
    // 进程退出后写 stdin 会得到 EPIPE；结束原因已经由 exit/error 报告。
    this.child.stdin.on("error", () => undefined)
    // Codex 把运行日志写到 stderr。没人读的管道写满约 64KB 后，原生进程会停在 write 上，
    // 之后一个通知都发不出来（#83）。持续读掉，并留最后一段给退出原因用。
    this.child.stderr.setEncoding("utf8")
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS)
    })
    this.child.stderr.on("error", () => undefined)
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      for (const listener of this.listeners) listener(line)
    })
  }

  send(line: string): void {
    if (this.closed || !this.child.stdin.writable) return
    this.child.stdin.write(`${line}\n`)
  }

  onLine(listener: (line: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onClose(listener: (reason: Error) => void): () => void {
    if (this.closed) {
      listener(this.closed)
      return () => undefined
    }
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  close(): Promise<void> {
    return this.tree.terminate()
  }

  private finish(reason: Error): void {
    if (this.closed) return
    this.closed = reason
    for (const listener of [...this.closeListeners]) listener(reason)
    this.closeListeners.clear()
  }
}

/** 进程退出原因后面补上 stderr 末尾；真正的错误通常在那里。 */
function withStderr(message: string, stderrTail: string): string {
  const detail = stderrTail.trim()
  return detail && !message.includes(detail) ? `${message}: ${detail}` : message
}

/** 测试用回放传输：记录发送内容，并可主动推入服务端消息。 */
export class ReplayCodexTransport implements CodexTransport {
  readonly sent: string[] = []
  private readonly listeners = new Set<(line: string) => void>()

  constructor(private readonly lines: string[]) {}

  send(line: string): void {
    this.sent.push(line)
  }

  onLine(listener: (line: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 测试主动推入一条服务端消息。 */
  push(value: unknown): void {
    const line = JSON.stringify(value)
    for (const listener of this.listeners) listener(line)
  }

  close(): void {
    this.listeners.clear()
  }
}
