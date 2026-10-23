/** 验证 thread.switchProvider 的会话停止、handoff 生成与下一次 run 注入。 */
import { Context } from "cordis"
import { describe, expect, it } from "vitest"
import type { CreateSessionInput, ProviderDriver, ProviderSessionHandle, UserInput } from "./driver"
import { ClaudeDriver } from "@pigcode/provider-claude/driver"
import { replayQuery } from "@pigcode/provider-claude/replay"
import { FakeProviderDriver } from "./fake"
import { apply as providers } from "./registry"
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
  driver: ProviderDriver
  inputs: UserInput[]
  created: CreateSessionInput[]
  disposed: ProviderSessionHandle[]
} {
  const inputs: UserInput[] = []
  const created: CreateSessionInput[] = []
  const disposed: ProviderSessionHandle[] = []
  const driver: ProviderDriver = {
    id,
    displayName: id,
    capabilities: new FakeProviderDriver().capabilities,
    async createSession(input) {
      created.push(input)
      return {
        id: `ps_${id}_${created.length}`,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: input.nativeSessionId ?? null,
        permissionMode: input.permissionMode ?? "workspace-write",
        model: input.model ?? null,
      }
    },
    async send(_session: ProviderSessionHandle, input, runtime) {
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
async function setup(providerId = "fake") {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(providers)
  const claude = recordingDriver("claude")
  ctx.providers.register(claude.driver)
  const project = ctx.projects.add("/tmp/pigcode-m2")
  const thread = ctx.threads.create(project.id, "M2", providerId)
  return { ctx, thread, claude }
}

describe("provider switching", () => {
  it("switches provider and passes a handoff to the next run", async () => {
    const { ctx, thread, claude } = await setup()
    const first = await ctx.providers.startRun(thread.id, "build the login page")
    await first.done

    const switched = await ctx.providers.switchProvider(thread.id, "claude", "claude-sonnet")
    expect(switched.providerId).toBe("claude")
    expect(switched.modelId).toBe("claude-sonnet")
    expect(switched.forkFromNativeSessionId).toBeNull()

    const events = ctx.sessions.read(thread.id, 0)
    const handoffEvent = events.find((event) => event.type === "thread.updated")
    expect(handoffEvent?.payload).toMatchObject({
      providerId: "claude",
      modelId: "claude-sonnet",
    })
    const handoff = (handoffEvent?.payload as { handoff: string }).handoff
    expect(handoff).toBe(
      [
        "Previous provider: fake",
        "Recent conversation:",
        "- user: build the login page",
        "- assistant: Hello from fake provider",
        "Recent tools: (none)",
        "Continue from here. Do not repeat completed work.",
      ].join("\n"),
    )
    expect(switched.handoff).toBe(handoff)

    const updated = ctx.threads.get(thread.id)
    expect(updated?.lastProviderId).toBe("claude")
    expect(updated?.lastModelId).toBe("claude-sonnet")

    const oldSession = ctx.providers
      .listSessions(thread.id)
      .find((session) => session.providerId === "fake")
    expect(oldSession?.status).toBe("stopped")
    expect(oldSession?.stoppedAt).not.toBeNull()

    const next = await ctx.providers.startRun(thread.id, "continue")
    await next.done
    expect(claude.inputs[0]).toEqual({ text: "continue", handoff })
    // 跨 provider 切换没有可 fork 的原生会话，createSession 不携带 fork 源。
    expect(claude.created[0]?.forkFromNativeSessionId).toBeUndefined()

    // handoff 只作用于切换后的第一次消息，避免后续每轮重复注入。
    const third = await ctx.providers.startRun(thread.id, "again")
    await third.done
    expect(claude.inputs[1]).toEqual({ text: "again" })
    await ctx.fiber.dispose()
  })

  it("forks the same provider's active native session instead of using handoff", async () => {
    const { ctx, thread } = await setup("claude")
    const claude = recordingDriver("claude", { nativeSessionId: "native_parent" })
    ctx.providers.register(claude.driver)

    const first = await ctx.providers.startRun(thread.id, "build the login page")
    await first.done
    expect(ctx.providers.listSessions(thread.id)[0]?.nativeSessionId).toBe("native_parent")

    // 同一 provider 且存在 active 原生会话：切换时记录 fork 源，而不是生成 handoff。
    const switched = await ctx.providers.switchProvider(thread.id, "claude", "claude-sonnet")
    expect(switched).toMatchObject({
      providerId: "claude",
      modelId: "claude-sonnet",
      handoff: null,
      forkFromNativeSessionId: "native_parent",
    })

    const updated = ctx.sessions
      .read(thread.id, 0)
      .filter((event) => event.type === "thread.updated")
      .at(-1)
    expect(updated?.payload).toMatchObject({
      providerId: "claude",
      modelId: "claude-sonnet",
      forkFromNativeSessionId: "native_parent",
    })
    expect((updated?.payload as { handoff?: unknown }).handoff).toBeUndefined()

    const next = await ctx.providers.startRun(thread.id, "continue")
    await next.done
    expect(claude.created.at(-1)).toMatchObject({
      threadId: thread.id,
      nativeSessionId: null,
      forkFromNativeSessionId: "native_parent",
    })
    // fork 复用原生上下文，不再额外注入 handoff。
    expect(claude.inputs.at(-1)).toEqual({ text: "continue" })

    // fork 只作用于切换后的第一次 run，后续 run 恢复新的活跃会话。
    const third = await ctx.providers.startRun(thread.id, "again")
    await third.done
    expect(claude.created.at(-1)?.forkFromNativeSessionId).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it("includes recent messages and tool names in a cross-provider handoff", async () => {
    const { ctx, thread } = await setup()
    const fake = recordingDriver("fake", { tools: ["Bash", "ApplyPatch"] })
    ctx.providers.register(fake.driver)

    const first = await ctx.providers.startRun(thread.id, "first")
    await first.done
    const second = await ctx.providers.startRun(thread.id, "second")
    await second.done

    const switched = await ctx.providers.switchProvider(thread.id, "claude", null)
    expect(switched.handoff).toBe(
      [
        "Previous provider: fake",
        "Recent conversation:",
        "- assistant: fake reply",
        "- user: second",
        "- assistant: fake reply",
        "Recent tools: Bash, ApplyPatch",
        "Continue from here. Do not repeat completed work.",
      ].join("\n"),
    )
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

  it("dispatches thread.switchProvider over RPC with a nullable model", async () => {
    const { ctx, thread } = await setup()
    const transport = new MemoryTransport()
    const server = new RpcServer(ctx, transport.host)
    server.start()
    transport.client.send({
      jsonrpc: "2.0",
      id: "1",
      method: "thread.switchProvider",
      params: { threadId: thread.id, providerId: "claude", modelId: null },
    })
    const response = (await transport.client.next()) as {
      result: { providerId: string; modelId: string | null }
    }
    expect(response.result).toMatchObject({ providerId: "claude", modelId: null })
    server.stop()
    await ctx.fiber.dispose()
  })

  it("rejects switching to an unknown provider", async () => {
    const { ctx, thread } = await setup()
    await expect(ctx.providers.switchProvider(thread.id, "missing")).rejects.toThrow(
      "provider not found",
    )
    await ctx.fiber.dispose()
  })

  it("rejects switching while a run is active", async () => {
    const { ctx, thread } = await setup()
    const slow: ProviderDriver = {
      id: "slow",
      displayName: "Slow",
      capabilities: new FakeProviderDriver().capabilities,
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
    ctx.providers.register(slow)
    ctx.threads.updateSelection(thread.id, "slow", null)

    const run = await ctx.providers.startRun(thread.id, "long")
    await expect(ctx.providers.switchProvider(thread.id, "claude", null)).rejects.toThrow(
      "RUN_ALREADY_ACTIVE",
    )

    ctx.providers.cancelRun(run.runId)
    await run.done
    await ctx.fiber.dispose()
  })

  it("disposes the previous provider session before switching", async () => {
    const { ctx, thread } = await setup()
    const fake = recordingDriver("fake")
    ctx.providers.register(fake.driver)

    const first = await ctx.providers.startRun(thread.id, "one")
    await first.done
    await ctx.providers.switchProvider(thread.id, "claude", null)

    expect(fake.disposed).toHaveLength(1)
    await ctx.fiber.dispose()
  })
})
