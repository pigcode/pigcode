/** 没装 Codex 或 app-server 中途退出时：Host 不崩溃，请求立即失败，正在进行的一轮以失败结束。 */
import { describe, expect, it } from "vitest"
import type { AgentRuntime } from "@pigcode/plugin-sdk"
import { CodexRpcClient } from "./client"
import { CodexDriver } from "./driver"
import { StdioCodexTransport, type CodexTransport } from "./transport"

/** 可以手动「退出」的传输：记录发送的消息，按脚本应答。 */
class ExitingTransport implements CodexTransport {
  readonly sent: Array<{ id?: number; method?: string }> = []
  private readonly lineListeners = new Set<(line: string) => void>()
  private readonly closeListeners = new Set<(reason: Error) => void>()

  constructor(private readonly answer: (message: { id?: number; method?: string }) => unknown) {}

  send(line: string): void {
    const message = JSON.parse(line) as { id?: number; method?: string }
    this.sent.push(message)
    const result = this.answer(message)
    if (result !== undefined && message.id !== undefined) {
      queueMicrotask(() => this.emit({ id: message.id, result }))
    }
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener)
    return () => this.lineListeners.delete(listener)
  }

  onClose(listener: (reason: Error) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  exit(reason = "codex app-server exited (SIGKILL)"): void {
    for (const listener of [...this.closeListeners]) listener(new Error(reason))
  }

  close(): void {}

  private emit(value: unknown): void {
    for (const listener of this.lineListeners) listener(JSON.stringify(value))
  }
}

const runtime = (): AgentRuntime => ({
  signal: new AbortController().signal,
  emit: () => undefined,
  requestApproval: async () => "allow-once",
})

describe("Codex without a working app-server", () => {
  it("reports a missing CLI through onClose instead of throwing", async () => {
    const transport = new StdioCodexTransport("/nonexistent/pigcode-codex")
    const reason = await new Promise<Error>((resolve) =>
      transport.onClose((error) => resolve(error)),
    )
    expect(reason.message).toContain("codex app-server unavailable")
    expect(() => transport.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}')).not.toThrow()
    expect(() => transport.close()).not.toThrow()
  })

  it("returns an empty model catalog right away and fails new sessions with a readable error", async () => {
    const driver = new CodexDriver({
      transportFactory: () => new StdioCodexTransport("/nonexistent/pigcode-codex"),
    })
    const started = Date.now()
    await expect(driver.listModels()).resolves.toEqual([])
    expect(Date.now() - started).toBeLessThan(5000)
    await expect(driver.createSession({ threadId: "t1", cwd: "/tmp" })).rejects.toThrow(
      "codex app-server unavailable",
    )
  })

  it("rejects requests that are waiting when the process goes away, and later requests too", async () => {
    const transport = new ExitingTransport(() => undefined)
    const client = new CodexRpcClient(transport)
    const pending = client.request("model/list", {})
    transport.exit()
    await expect(pending).rejects.toThrow("codex app-server exited")
    await expect(client.request("model/list", {})).rejects.toThrow("codex app-server exited")
  })

  it("fails the running turn when the app-server exits mid-turn", async () => {
    const transport = new ExitingTransport((message) => {
      if (message.method === "initialize") return {}
      if (message.method === "thread/start") return { thread: { id: "th_native" } }
      if (message.method === "turn/start") return { turn: { id: "turn_1" } }
      return undefined
    })
    const driver = new CodexDriver({ transportFactory: () => transport })
    const session = await driver.createSession({ threadId: "t1", cwd: "/tmp" })
    const turn = driver.send(session, { text: "hello" }, runtime())
    await new Promise((resolve) => setTimeout(resolve, 10))
    transport.exit()
    await expect(turn).rejects.toThrow("codex app-server exited")
  })
})
