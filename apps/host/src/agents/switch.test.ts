/** 验证 thread.switchAgent 的会话停止、handoff 生成与下一次 run 注入。 */
import { Context } from "cordis"
import { describe, expect, it } from "vitest"
import type { CreateSessionInput, AgentDriver, AgentSessionHandle, UserInput } from "./driver"
import { ClaudeDriver } from "@pigcode/agent-claude/driver"
import { replayQuery } from "@pigcode/agent-claude/replay"
import { FakeAgentDriver } from "./fake"
import { HandoffStore } from "../storage/handoff-store"
import { apply as agentsPlugin } from "./registry"
import { MemoryTransport } from "../rpc/memory-transport"
import { RpcServer } from "../rpc/server"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"

/** 记录 createSession/send 入参与 dispose 调用，用来观察 fork、handoff 与旧会话清理。 */
function recordingDriver(
  id: string,
  options: { nativeSessionId?: string; tools?: string[] } = {},
): {
  driver: AgentDriver
  inputs: UserInput[]
  created: CreateSessionInput[]
  disposed: AgentSessionHandle[]
} {
  const inputs: UserInput[] = []
  const created: CreateSessionInput[] = []
  const disposed: AgentSessionHandle[] = []
  const driver: AgentDriver = {
    id,
    displayName: id,
    features: new FakeAgentDriver().features,
    async createSession(input) {
      created.push(input)
      return {
        // 和真实 driver 一样沿用 Host 传进来的会话 id。
        id: input.sessionId ?? `ps_${id}_${created.length}`,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: input.nativeSessionId ?? null,
        permissionMode: input.permissionMode ?? "workspace-write",
        model: input.model ?? null,
      }
    },
    async send(_session: AgentSessionHandle, input, runtime) {
      inputs.push(input)
      if (options.nativeSessionId) {
        runtime.emit({ type: "session.started", nativeSessionId: options.nativeSessionId })
      }
      for (const name of options.tools ?? []) {
        runtime.emit({
          type: "tool.completed",
          toolCallId: `tool_${name}`,
          name,
          output: "",
          isError: false,
        })
      }
      runtime.emit({ type: "message.completed", text: `${id} reply` })
      runtime.emit({ type: "run.completed" })
    },
    interrupt: async () => undefined,
    async dispose(session) {
      disposed.push(session)
    },
  }
  return { driver, inputs, created, disposed }
}

/** 建立内存 Host；claude 用记录型 driver 覆盖，避免测试启动真实进程。 */
async function setup(agentId = "fake") {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agentsPlugin)
  const claude = recordingDriver("claude")
  ctx.agents.register(claude.driver)
  const project = ctx.projects.add("/tmp/pigcode-m2")
  const thread = ctx.threads.create(project.id, "M2", agentId)
  return { ctx, thread, claude }
}

describe("agent switching", () => {
  it("holds the handoff back while the message starts with an agent command", async () => {
    const { ctx, thread, claude } = await setup()
    await (
      await ctx.agents.startRun(thread.id, "build the login page")
    ).done
    await ctx.agents.switchAgent(thread.id, "claude", null)

    await (
      await ctx.agents.startRun(thread.id, "/compact keep the decisions")
    ).done
    expect(claude.inputs[0]?.text).toBe("/compact keep the decisions")
    expect(claude.inputs[0]?.handoff).toBeUndefined()

    await (
      await ctx.agents.startRun(thread.id, "/usr/lib/foo 在哪")
    ).done
    expect(claude.inputs[1]?.handoff).toContain("build the login page")

    await (
      await ctx.agents.startRun(thread.id, "and the signup page")
    ).done
    expect(claude.inputs[2]?.handoff).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it("switches agent and passes a handoff to the next run", async () => {
    const { ctx, thread, claude } = await setup()
    const first = await ctx.agents.startRun(thread.id, "build the login page")
    await first.done

    const switched = await ctx.agents.switchAgent(thread.id, "claude", "claude-sonnet")
    expect(switched.agentId).toBe("claude")
    expect(switched.modelId).toBe("claude-sonnet")
    expect(switched.forkFromNativeSessionId).toBeNull()

    const events = ctx.sessions.read(thread.id, 0)
    const handoffEvent = events.find((event) => event.type === "thread.updated")
    expect(handoffEvent?.payload).toMatchObject({
      agentId: "claude",
      modelId: "claude-sonnet",
    })
    // 交接记在 thread_handoffs 里，事件只带它的 id。
    const handoffId = (handoffEvent?.payload as { handoffId: string }).handoffId
    const record = new HandoffStore(ctx.storage.db).get(handoffId)
    expect(record).toMatchObject({
      strategy: "switch",
      fromInstanceIds: ["fake"],
      toInstanceId: "claude",
      delivery: "pending",
    })
    const handoff = record?.text
    expect(handoff).toContain("carried on by fake before you joined")
    expect(handoff).toContain("Selected 2 intact items from this conversation; omitted 0.")
    expect(handoff).toMatch(
      /\]\nbuild the login page\n\n\[Historical assistant;[^\]]*\]\nHello from fake agent$/,
    )
    expect(record?.selectedItemIds).toHaveLength(2)
    expect(switched.handoff).toBe(handoff)

    const updated = ctx.threads.get(thread.id)
    expect(updated?.lastAgentId).toBe("claude")
    expect(updated?.lastModelId).toBe("claude-sonnet")

    const oldSession = ctx.agents
      .listSessions(thread.id)
      .find((session) => session.agentId === "fake")
    // 切走的会话停放着，切回来时还能接上（#78）。
    expect(oldSession?.status).toBe("parked")
    expect(oldSession?.stoppedAt).not.toBeNull()

    const next = await ctx.agents.startRun(thread.id, "continue")
    await next.done
    expect(claude.inputs[0]).toEqual({ text: "continue", handoff })
    expect(new HandoffStore(ctx.storage.db).get(handoffId)).toMatchObject({
      delivery: "inline",
      targetRunId: next.runId,
    })
    // 换 Agent 时没有可 fork 的原生会话，createSession 不携带 fork 源。
    expect(claude.created[0]?.forkFromNativeSessionId).toBeUndefined()

    // handoff 只作用于切换后的第一次消息，避免后续每轮重复注入。
    const third = await ctx.agents.startRun(thread.id, "again")
    await third.done
    expect(claude.inputs[1]).toEqual({ text: "again" })
    await ctx.fiber.dispose()
  })

  it("resumes the earlier session when switching back and hands over only what happened since", async () => {
    const { ctx, thread } = await setup("alpha")
    const alpha = recordingDriver("alpha", { nativeSessionId: "native_a" })
    const beta = recordingDriver("beta", { nativeSessionId: "native_b" })
    ctx.agents.register(alpha.driver)
    ctx.agents.register(beta.driver)
    const run = async (text: string) => (await ctx.agents.startRun(thread.id, text)).done

    await run("alpha builds the parser")
    const toBeta = await ctx.agents.switchAgent(thread.id, "beta", null)
    expect(toBeta.handoff).toContain("alpha builds the parser")
    await run("beta adds tests")

    await ctx.agents.switchAgent(thread.id, "alpha", null)
    const marker = ctx.sessions
      .read(thread.id, 0)
      .filter((event) => event.type === "thread.updated")
      .at(-1)?.payload as Record<string, unknown>
    expect(marker).toMatchObject({
      agentId: "alpha",
      resumed: true,
      handoffItems: 2,
      handoffOmitted: 0,
    })
    const delta = new HandoffStore(ctx.storage.db).get(marker.handoffId as string)
    expect(delta?.strategy).toBe("switch_delta")

    await run("alpha, carry on")
    // 接回原来的原生会话，而不是开新的。
    expect(alpha.created.at(-1)?.nativeSessionId).toBe("native_a")
    const handoff = alpha.inputs.at(-1)?.handoff ?? ""
    expect(handoff).toContain("you are back in your earlier session")
    expect(handoff).toContain("beta adds tests")
    expect(handoff).toContain("beta reply")
    // 它自己原来的那段不再交接一遍。
    expect(handoff).not.toContain("alpha builds the parser")
    const alphaRows = ctx.agents.listSessions(thread.id).filter((row) => row.agentId === "alpha")
    expect(alphaRows.map((row) => row.status)).toEqual(["active"])
    await ctx.fiber.dispose()
  })

  it("resumes without a handoff when nothing happened while the agent was away", async () => {
    const { ctx, thread } = await setup("alpha")
    const alpha = recordingDriver("alpha", { nativeSessionId: "native_a" })
    ctx.agents.register(alpha.driver)
    ctx.agents.register(recordingDriver("beta").driver)
    await (
      await ctx.agents.startRun(thread.id, "alpha builds the parser")
    ).done
    await ctx.agents.switchAgent(thread.id, "beta", null)
    const back = await ctx.agents.switchAgent(thread.id, "alpha", null)
    expect(back.handoff).toBeNull()
    await (
      await ctx.agents.startRun(thread.id, "go on")
    ).done
    expect(alpha.created.at(-1)?.nativeSessionId).toBe("native_a")
    expect(alpha.inputs.at(-1)).toEqual({ text: "go on" })
    await ctx.fiber.dispose()
  })

  it("forks the same agent's active native session instead of using handoff", async () => {
    const { ctx, thread } = await setup("claude")
    const claude = recordingDriver("claude", { nativeSessionId: "native_parent" })
    ctx.agents.register(claude.driver)

    const first = await ctx.agents.startRun(thread.id, "build the login page")
    await first.done
    expect(ctx.agents.listSessions(thread.id)[0]?.nativeSessionId).toBe("native_parent")

    // 同一个 Agent 且存在 active 原生会话：切换时记录 fork 源，而不是生成 handoff。
    const switched = await ctx.agents.switchAgent(thread.id, "claude", "claude-sonnet")
    expect(switched).toMatchObject({
      agentId: "claude",
      modelId: "claude-sonnet",
      handoff: null,
      forkFromNativeSessionId: "native_parent",
    })

    const updated = ctx.sessions
      .read(thread.id, 0)
      .filter((event) => event.type === "thread.updated")
      .at(-1)
    expect(updated?.payload).toMatchObject({
      agentId: "claude",
      modelId: "claude-sonnet",
      forkFromNativeSessionId: "native_parent",
    })
    expect((updated?.payload as { handoff?: unknown }).handoff).toBeUndefined()

    const next = await ctx.agents.startRun(thread.id, "continue")
    await next.done
    expect(claude.created.at(-1)).toMatchObject({
      threadId: thread.id,
      nativeSessionId: null,
      forkFromNativeSessionId: "native_parent",
    })
    // fork 复用原生上下文，不再额外注入 handoff。
    expect(claude.inputs.at(-1)).toEqual({ text: "continue" })

    // fork 只作用于切换后的第一次 run，后续 run 恢复新的活跃会话。
    const third = await ctx.agents.startRun(thread.id, "again")
    await third.done
    expect(claude.created.at(-1)?.forkFromNativeSessionId).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it("includes the messages, commands and file changes in a cross-agent handoff", async () => {
    const { ctx, thread } = await setup()
    const fake = recordingDriver("fake", { tools: ["Bash", "ApplyPatch"] })
    ctx.agents.register(fake.driver)

    const first = await ctx.agents.startRun(thread.id, "first")
    await first.done
    const second = await ctx.agents.startRun(thread.id, "second")
    await second.done

    const switched = await ctx.agents.switchAgent(thread.id, "claude", null)
    // 两轮的用户消息、回答都在；命令和改文件也在，按发生的顺序。
    const kinds = [...(switched.handoff ?? "").matchAll(/\[Historical \w+; (\w+);/g)].map(
      (match) => match[1],
    )
    expect(kinds).toEqual([
      "user_message",
      "command",
      "file_change",
      "assistant_message",
      "user_message",
      "command",
      "file_change",
      "assistant_message",
    ])
    await ctx.fiber.dispose()
  })

  it("puts the handoff before the user text in the Claude prompt", async () => {
    const prompts: unknown[] = []
    const replay = replayQuery("fixtures/simple.jsonl")
    const driver = new ClaudeDriver({
      queryFn: (params) => {
        prompts.push(params.prompt)
        return replay(params)
      },
    })
    const session = await driver.createSession({ threadId: "t1", cwd: "/tmp" })

    await driver.send(
      session,
      { text: "hello", handoff: "context" },
      {
        signal: new AbortController().signal,
        emit: () => undefined,
        requestApproval: async () => "allow-once",
      },
    )

    expect(prompts).toEqual(["context\n\nhello"])
  })

  it("dispatches thread.switchAgent over RPC", async () => {
    const { ctx, thread } = await setup()
    const transport = new MemoryTransport()
    const server = new RpcServer(ctx, transport.host)
    server.start()
    transport.client.send({
      jsonrpc: "2.0",
      id: "1",
      method: "thread.switchAgent",
      params: { threadId: thread.id, agentId: "claude", modelId: null },
    })
    const response = (await transport.client.next()) as {
      result: { agentId: string; modelId: string | null }
    }
    expect(response.result).toMatchObject({ agentId: "claude", modelId: null })
    server.stop()
    await ctx.fiber.dispose()
  })

  it("rejects switching to an unknown agent", async () => {
    const { ctx, thread } = await setup()
    await expect(ctx.agents.switchAgent(thread.id, "missing")).rejects.toThrow("agent not found")
    await ctx.fiber.dispose()
  })

  it("rejects switching while a run is active", async () => {
    const { ctx, thread } = await setup()
    const slow: AgentDriver = {
      id: "slow",
      displayName: "Slow",
      features: new FakeAgentDriver().features,
      async createSession(input) {
        return {
          id: "ps_slow",
          threadId: input.threadId,
          cwd: input.cwd,
          nativeSessionId: null,
          permissionMode: "workspace-write",
          model: null,
        }
      },
      send: () => new Promise<void>(() => undefined),
      interrupt: async () => undefined,
      dispose: async () => undefined,
    }
    ctx.agents.register(slow)
    ctx.threads.updateSelection(thread.id, "slow", null)

    const run = await ctx.agents.startRun(thread.id, "long")
    await expect(ctx.agents.switchAgent(thread.id, "claude", null)).rejects.toThrow(
      "RUN_ALREADY_ACTIVE",
    )

    ctx.agents.cancelRun(run.runId)
    await run.done
    await ctx.fiber.dispose()
  })

  it("disposes the previous agent session before switching", async () => {
    const { ctx, thread } = await setup()
    const fake = recordingDriver("fake")
    ctx.agents.register(fake.driver)

    const first = await ctx.agents.startRun(thread.id, "one")
    await first.done
    await ctx.agents.switchAgent(thread.id, "claude", null)

    expect(fake.disposed).toHaveLength(1)
    await ctx.fiber.dispose()
  })
})
