/** 用 scripted replay transport 驱动 CodexDriver，验证协议交互与事件归一化。 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { ProviderEvent } from "@pigcode/contracts"
import { describe, expect, it } from "vitest"
import type { ApprovalDecision, ApprovalRequest, ProviderRuntime } from "../driver"
import { CodexDriver } from "./driver"
import { ReplayCodexTransport } from "./transport"

/** 客户端发出的 JSON-RPC 消息。 */
interface SentMessage {
  jsonrpc: string
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
}

/** 服务端应答脚本；在收到客户端消息时推入响应。 */
interface ReplayScript {
  nativeThreadId: string
  onTurnStart?: (message: SentMessage, transport: ScriptedTransport) => void
  onTurnInterrupt?: (message: SentMessage, transport: ScriptedTransport) => void
}

/** 在 ReplayCodexTransport 之上按脚本应答请求，模拟 app-server。 */
class ScriptedTransport extends ReplayCodexTransport {
  closed = false

  constructor(private readonly script: ReplayScript) {
    super([])
  }

  override send(line: string): void {
    super.send(line)
    const message = JSON.parse(line) as SentMessage
    if (message.method === "initialize") {
      this.push({ id: message.id, result: {} })
      return
    }
    if (message.method === "thread/start" || message.method === "thread/resume") {
      const params = message.params as { threadId?: string } | undefined
      const id = params?.threadId ?? this.script.nativeThreadId
      this.push({ id: message.id, result: { thread: { id } } })
      return
    }
    if (message.method === "turn/start") {
      this.script.onTurnStart?.(message, this)
      return
    }
    if (message.method === "turn/interrupt") {
      this.script.onTurnInterrupt?.(message, this)
      this.push({ id: message.id, result: {} })
    }
  }

  override close(): void {
    this.closed = true
    super.close()
  }
}

/** 读取 JSONL fixture 中的服务端帧。 */
function readFrames(file: string): unknown[] {
  const path = file.startsWith("/") ? file : join(import.meta.dirname, file)
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
}

/** 解析 transport 发出的全部消息。 */
function sentMessages(transport: ScriptedTransport): SentMessage[] {
  return transport.sent.map((line) => JSON.parse(line) as SentMessage)
}

/** 取最近一条指定方法的客户端消息。 */
function messageOf(transport: ScriptedTransport, method: string): SentMessage | undefined {
  return sentMessages(transport)
    .filter((message) => message.method === method)
    .at(-1)
}

/** 构造带脚本化应答的 driver。 */
function setup(script: Partial<ReplayScript> = {}): {
  driver: CodexDriver
  transport: ScriptedTransport
} {
  const transport = new ScriptedTransport({ nativeThreadId: "th_native", ...script })
  return { driver: new CodexDriver({ transportFactory: () => transport }), transport }
}

/** 构造直连 driver 的 runtime，并收集事件。 */
function runtimeFor(
  options: {
    signal?: AbortSignal
    onApproval?: (request: ApprovalRequest) => ApprovalDecision
  } = {},
): { runtime: ProviderRuntime; events: ProviderEvent[]; controller: AbortController } {
  const controller = new AbortController()
  const events: ProviderEvent[] = []
  const runtime: ProviderRuntime = {
    signal: options.signal ?? controller.signal,
    emit: (event) => events.push(event),
    requestApproval: async (request) => options.onApproval?.(request) ?? "allow-once",
  }
  return { runtime, events, controller }
}

/** 轮询到条件成立，避免依赖固定 sleep。 */
async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("condition not met")
}

describe("CodexDriver", () => {
  it("initializes the app-server and starts a thread with mapped params", async () => {
    const { driver, transport } = setup()
    const session = await driver.createSession({
      threadId: "t1",
      cwd: "/tmp/project",
      permissionMode: "danger-full-access",
      model: "gpt-5-codex",
    })

    expect(messageOf(transport, "initialize")?.params).toEqual({
      clientInfo: { name: "pigcode", title: "Pigcode", version: "0.1.0" },
    })
    expect(messageOf(transport, "thread/start")?.params).toMatchObject({
      cwd: "/tmp/project",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      model: "gpt-5-codex",
    })
    expect(session).toMatchObject({
      threadId: "t1",
      cwd: "/tmp/project",
      nativeSessionId: "th_native",
      permissionMode: "danger-full-access",
      model: "gpt-5-codex",
    })
  })

  it("maps read-only permission to a read-only sandbox", async () => {
    const { driver, transport } = setup()
    await driver.createSession({ threadId: "t1", cwd: "/tmp", permissionMode: "read-only" })
    expect(messageOf(transport, "thread/start")?.params).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "read-only",
    })
  })

  it("resumes a native thread instead of starting a new one", async () => {
    const { driver, transport } = setup()
    const session = await driver.createSession({
      threadId: "t1",
      cwd: "/tmp",
      nativeSessionId: "th_existing",
    })

    expect(messageOf(transport, "thread/resume")?.params).toMatchObject({
      threadId: "th_existing",
      cwd: "/tmp",
      sandbox: "workspace-write",
    })
    expect(messageOf(transport, "thread/start")).toBeUndefined()
    expect(session.nativeSessionId).toBe("th_existing")
  })

  it("normalizes a replayed turn into provider events", async () => {
    const frames = readFrames("fixtures/simple.jsonl")
    const { driver, transport } = setup({
      onTurnStart: (message, replay) => {
        replay.push({ id: message.id, result: { turn: { id: "turn_1" } } })
        setTimeout(() => {
          for (const frame of frames) replay.push(frame)
        }, 0)
      },
    })
    const session = await driver.createSession({ threadId: "t1", cwd: "/tmp" })
    const { runtime, events } = runtimeFor()

    await driver.send(session, { text: "hello", handoff: "context" }, runtime)

    expect(messageOf(transport, "turn/start")?.params).toMatchObject({
      threadId: "th_native",
      input: [{ type: "text", text: "context\n\nhello" }],
    })
    expect(events).toContainEqual({ type: "message.delta", text: "OK" })
    expect(events).toContainEqual({
      type: "tool.completed",
      toolCallId: "item_cmd",
      name: "Bash",
      output: "hi",
      isError: false,
    })
    expect(events).toContainEqual({
      type: "tool.completed",
      toolCallId: "item_patch",
      name: "ApplyPatch",
      output: [{ path: "a.txt", kind: "add" }],
      isError: false,
    })
    expect(events).toContainEqual({ type: "message.completed", text: "OK" })
    expect(events).toContainEqual({
      type: "plan.updated",
      explanation: "Plan",
      plan: [{ step: "do it", status: "completed" }],
    })
    expect(events).toContainEqual({
      type: "usage.updated",
      usage: { inputTokens: 10, outputTokens: 5 },
    })
    expect(events.at(-1)).toEqual({ type: "run.completed" })
  })

  it("maps turn failure to run.failed", async () => {
    const { driver } = setup({
      onTurnStart: (message, replay) => {
        replay.push({ id: message.id, result: { turn: { id: "turn_1" } } })
        setTimeout(() => {
          replay.push({
            method: "turn/completed",
            params: {
              threadId: "th_native",
              turn: { id: "turn_1", status: "failed", error: { message: "boom" } },
            },
          })
        }, 0)
      },
    })
    const session = await driver.createSession({ threadId: "t1", cwd: "/tmp" })
    const { runtime, events } = runtimeFor()

    await driver.send(session, { text: "hello" }, runtime)

    expect(events).toContainEqual({ type: "run.failed", message: "boom" })
  })

  const mappings: Array<[ApprovalDecision, string]> = [
    ["allow-once", "accept"],
    ["allow-for-session", "acceptForSession"],
    ["deny", "decline"],
  ]

  it.each(mappings)("maps %s approval to %s", async (decision, expected) => {
    const { driver, transport } = setup({
      onTurnStart: (message, replay) => {
        replay.push({ id: message.id, result: { turn: { id: "turn_1" } } })
        setTimeout(() => {
          replay.push({
            id: "srv_1",
            method: "item/commandExecution/requestApproval",
            params: { itemId: "item_cmd", command: "echo hi" },
          })
        }, 0)
      },
    })
    const session = await driver.createSession({ threadId: "t1", cwd: "/tmp" })
    const approvals: ApprovalRequest[] = []
    const { runtime, events } = runtimeFor({
      onApproval: (request) => {
        approvals.push(request)
        return decision
      },
    })

    const send = driver.send(session, { text: "run" }, runtime)
    await waitFor(() => sentMessages(transport).some((message) => message.id === "srv_1"))
    const response = sentMessages(transport).find((message) => message.id === "srv_1")
    expect(response?.result).toEqual({ decision: expected })
    expect(approvals[0]).toMatchObject({ toolName: "Bash" })

    transport.push({
      method: "turn/completed",
      params: { threadId: "th_native", turn: { id: "turn_1", status: "completed" } },
    })
    await send
    expect(events).toContainEqual({ type: "run.completed" })
  })

  it("interrupts the active turn and emits run.interrupted", async () => {
    const { driver, transport } = setup({
      onTurnStart: (message, replay) => {
        replay.push({ id: message.id, result: { turn: { id: "turn_1" } } })
        setTimeout(() => {
          replay.push({
            method: "item/agentMessage/delta",
            params: { itemId: "item_msg", delta: "working" },
          })
        }, 0)
      },
      onTurnInterrupt: (_message, replay) => {
        setTimeout(() => {
          replay.push({
            method: "turn/completed",
            params: {
              threadId: "th_native",
              turn: { id: "turn_1", status: "interrupted" },
            },
          })
        }, 0)
      },
    })
    const session = await driver.createSession({ threadId: "t1", cwd: "/tmp" })
    const { runtime, events } = runtimeFor()

    const send = driver.send(session, { text: "long" }, runtime)
    await waitFor(() => events.some((event) => event.type === "message.delta"))
    await driver.interrupt(session)
    await send

    expect(messageOf(transport, "turn/interrupt")?.params).toMatchObject({
      threadId: "th_native",
      turnId: "turn_1",
    })
    expect(events).toContainEqual({ type: "run.interrupted" })
  })

  it("stops waiting and interrupts when the run signal aborts", async () => {
    const { driver, transport } = setup({
      onTurnStart: (message, replay) => {
        replay.push({ id: message.id, result: { turn: { id: "turn_1" } } })
        setTimeout(() => {
          replay.push({
            method: "item/agentMessage/delta",
            params: { itemId: "item_msg", delta: "working" },
          })
        }, 0)
      },
    })
    const session = await driver.createSession({ threadId: "t1", cwd: "/tmp" })
    const { runtime, events, controller } = runtimeFor()

    const send = driver.send(session, { text: "long" }, runtime)
    await waitFor(() => events.some((event) => event.type === "message.delta"))
    controller.abort()
    await send

    await waitFor(() => messageOf(transport, "turn/interrupt") !== undefined)
    expect(events.some((event) => event.type === "run.completed")).toBe(false)
  })

  it("closes the transport on dispose and is idempotent", async () => {
    const { driver, transport } = setup()
    const session = await driver.createSession({ threadId: "t1", cwd: "/tmp" })

    await driver.dispose(session)
    expect(transport.closed).toBe(true)

    await driver.dispose(session)
    expect(transport.closed).toBe(true)
  })
})
