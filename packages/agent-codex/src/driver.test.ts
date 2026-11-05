/** 用 scripted replay transport 驱动 CodexDriver，验证协议交互与事件归一化。 */
import type { AgentEvent } from "@pigcode/contracts"
import { describe, expect, it, vi } from "vitest"
import type {
  ApprovalDecision,
  ApprovalRequest,
  AgentRuntime,
  SessionMcp,
} from "@pigcode/plugin-sdk"
import { CodexDriver } from "./driver"
import {
  ScriptedTransport,
  messageOf,
  readFrames,
  sentMessages,
  type ReplayScript,
} from "./scripted-transport"

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
): { runtime: AgentRuntime; events: AgentEvent[]; controller: AbortController } {
  const controller = new AbortController()
  const events: AgentEvent[] = []
  const runtime: AgentRuntime = {
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

  it("forks a native thread instead of resuming it", async () => {
    const { driver, transport } = setup({
      nativeThreadId: "th_parent",
      forkedThreadId: "th_forked",
    })
    const session = await driver.createSession({
      threadId: "t1",
      cwd: "/tmp",
      nativeSessionId: "th_parent",
      forkFromNativeSessionId: "th_parent",
    })

    // fork 请求带上父 thread id 与共享参数，响应中的新 thread id 成为会话标识。
    expect(messageOf(transport, "thread/fork")?.params).toMatchObject({
      threadId: "th_parent",
      cwd: "/tmp",
      sandbox: "workspace-write",
    })
    expect(messageOf(transport, "thread/resume")).toBeUndefined()
    expect(messageOf(transport, "thread/start")).toBeUndefined()
    expect(session.nativeSessionId).toBe("th_forked")
  })

  it("injects MCP config into thread/start and thread/resume", async () => {
    const server = { command: "node", args: ["stdio-bridge.mjs"], env: { PIGCODE_MCP_TOKEN: "t" } }
    const mcp: SessionMcp = {
      tools: [{ name: "echo", description: "Echo", inputSchema: {} }],
      callTool: async () => null,
      stdioServer: () => server,
    }
    const config = { mcp_servers: { pigcode: server } }

    const started = setup()
    await started.driver.createSession({
      threadId: "t1",
      cwd: "/tmp",
      mcp,
    })
    expect(messageOf(started.transport, "thread/start")?.params).toMatchObject({ config })

    // resume 走同一份共享参数，MCP 配置同样要带上。
    const resumed = setup()
    await resumed.driver.createSession({
      threadId: "t2",
      cwd: "/tmp",
      nativeSessionId: "th_existing",
      mcp,
    })
    expect(messageOf(resumed.transport, "thread/resume")?.params).toMatchObject({
      threadId: "th_existing",
      config,
    })
  })

  it("normalizes a replayed turn into Agent events", async () => {
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
      exitCode: 0,
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

  it("reuses a live app-server for the same native thread", async () => {
    let created = 0
    const driver = new CodexDriver({
      transportFactory: () => {
        created += 1
        return new ScriptedTransport({ nativeThreadId: "th_native" })
      },
    })

    const first = await driver.createSession({ threadId: "t1", cwd: "/tmp", sessionId: "ps_1" })
    const second = await driver.createSession({
      threadId: "t1",
      cwd: "/tmp",
      sessionId: "ps_1",
      nativeSessionId: first.nativeSessionId,
    })

    expect(second.id).toBe("ps_1")
    expect(created).toBe(1)
    await driver.dispose(second)
  })

  it("lists models from the app server and closes the temporary transport", async () => {
    const transport = new ScriptedTransport({ nativeThreadId: "th_native" })
    const driver = new CodexDriver({ transportFactory: () => transport })

    const models = await driver.listModels()

    expect(models).toEqual([{ id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", isDefault: true }])
    expect(transport.closed).toBe(true)
  })
})

describe("CodexDriver process lifetime", () => {
  /** close 要等外部放行才完成的传输，模拟进程还没结束；initialize 可以设置成永远没有回应。 */
  class SlowClosingTransport extends ScriptedTransport {
    readonly closeCalled = vi.fn()
    finishClosing = (): void => undefined
    override close(): Promise<void> {
      this.closeCalled()
      return new Promise((resolve) => {
        this.finishClosing = resolve
      })
    }
  }

  /** 让 Promise 回调都跑完。 */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

  // 注销 driver 时注册表先 dispose 活跃会话，不等结果，接着插件才 await close；Host 紧接着就退出。
  it("close also waits for a dispose nobody awaited", async () => {
    const transport = new SlowClosingTransport({ nativeThreadId: "th_native" })
    const driver = new CodexDriver({ transportFactory: () => transport })
    const session = await driver.createSession({ threadId: "t1", cwd: "/tmp" })
    void driver.dispose(session)
    let finished = false
    const closed = driver.close().then(() => {
      finished = true
    })
    await settle()
    expect(transport.closeCalled).toHaveBeenCalledOnce()
    expect(finished).toBe(false)
    transport.finishClosing()
    await closed
    expect(finished).toBe(true)
  })

  it("close ends an app-server whose session is still being created", async () => {
    const transport = new SlowClosingTransport({ nativeThreadId: "th_native" })
    vi.spyOn(transport, "send").mockImplementation(() => undefined)
    const driver = new CodexDriver({ transportFactory: () => transport })
    void driver.createSession({ threadId: "t1", cwd: "/tmp" }).catch(() => undefined)
    const closed = driver.close()
    await settle()
    expect(transport.closeCalled).toHaveBeenCalledOnce()
    transport.finishClosing()
    await closed
  })
})
