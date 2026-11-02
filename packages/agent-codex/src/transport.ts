/** Codex 子进程的 NDJSON 传输；测试用 replay 实现。 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"

/** 按行收发 NDJSON 的最小传输接口；协议层不感知进程与回放的区别。 */
export interface CodexTransport {
  send(line: string): void
  onLine(listener: (line: string) => void): () => void
  /** 子进程启动失败或退出时回调一次；回放传输可以不实现。 */
  onClose?(listener: (reason: Error) => void): () => void
  close(): void
}

/**
 * 通过 `codex app-server --stdio` 子进程收发 NDJSON。
 * 没装 Codex（spawn ENOENT）或进程退出都只通知 onClose，不能让未处理的 error 事件
 * 带崩整个 Host 进程。
 */
export class StdioCodexTransport implements CodexTransport {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly listeners = new Set<(line: string) => void>()
  private readonly closeListeners = new Set<(reason: Error) => void>()
  private closed: Error | null = null

  constructor(
    command = "codex",
    args = ["app-server", "--stdio"],
    env: NodeJS.ProcessEnv | undefined = undefined,
  ) {
    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(env ? { env } : {}),
    })
    this.child.on("error", (error) =>
      this.finish(new Error(`codex app-server unavailable: ${error.message}`)),
    )
    this.child.on("exit", (code, signal) =>
      this.finish(new Error(`codex app-server exited (${signal ?? `code ${String(code)}`})`)),
    )
    // 进程退出后写 stdin 会得到 EPIPE；结束原因已经由 exit/error 报告。
    this.child.stdin.on("error", () => undefined)
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

  close(): void {
    if (!this.closed && this.child.exitCode === null) this.child.kill("SIGTERM")
  }

  private finish(reason: Error): void {
    if (this.closed) return
    this.closed = reason
    for (const listener of [...this.closeListeners]) listener(reason)
    this.closeListeners.clear()
  }
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
