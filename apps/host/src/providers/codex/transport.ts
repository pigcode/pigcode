/** Codex 子进程的 NDJSON 传输；测试用 replay 实现。 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"

/** 按行收发 NDJSON 的最小传输接口；协议层不感知进程与回放的区别。 */
export interface CodexTransport {
  send(line: string): void
  onLine(listener: (line: string) => void): () => void
  close(): void
}

/** 通过 `codex app-server --stdio` 子进程收发 NDJSON。 */
export class StdioCodexTransport implements CodexTransport {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly listeners = new Set<(line: string) => void>()

  constructor(command = "codex", args = ["app-server", "--stdio"]) {
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] })
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      for (const listener of this.listeners) listener(line)
    })
  }

  send(line: string): void {
    this.child.stdin.write(`${line}\n`)
  }

  onLine(listener: (line: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): void {
    this.child.kill("SIGTERM")
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
