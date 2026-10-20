/** 验证 thread.switchProvider 的会话停止、handoff 生成与下一次 run 注入。 */
import { Context } from "cordis"
import { describe, expect, it } from "vitest"
import type { ProviderDriver, ProviderSessionHandle, UserInput } from "./driver"
import { ClaudeDriver } from "./claude/driver"
import { replayQuery } from "./claude/replay"
import { FakeProviderDriver } from "./fake"
import { apply as providers } from "./registry"
import { MemoryTransport } from "../rpc/memory-transport"
import { RpcServer } from "../rpc/server"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"

/** 记录每次 send 的输入与 dispose 调用，用来观察 handoff 与旧会话清理。 */
function recordingDriver(id: string): {
  driver: ProviderDriver
  inputs: UserInput[]
  disposed: ProviderSessionHandle[]
} {
  const inputs: UserInput[] = []
  const disposed: ProviderSessionHandle[] = []
  const driver: ProviderDriver = {
    id,
    displayName: id,
    capabilities: new FakeProviderDriver().capabilities,
    async createSession(input) {
      return {
        id: `ps_${id}_${inputs.length}`,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: input.nativeSessionId ?? null,
        permissionMode: input.permissionMode ?? "workspace-write",
        model: input.model ?? null,
      }
    },
    async send(_session: ProviderSessionHandle, input, runtime) {
      inputs.push(input)
      runtime.emit({ type: "message.completed", text: `${id} reply` })
      runtime.emit({ type: "run.completed" })
    },
    interrupt: async () => undefined,
    async dispose(session) {
      disposed.push(session)
    },
  }
  return { driver, inputs, disposed }
}

/** 建立内存 Host；claude 用记录型 driver 覆盖，避免测试启动真实进程。 */
async function setup() {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(providers)
  const claude = recordingDriver("claude")
  ctx.providers.register(claude.driver)
  const project = ctx.projects.add("/tmp/pigcode-m2")
  const thread = ctx.threads.create(project.id, "M2", "fake")
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
        "Last user request: build the login page",
        "Last assistant summary: Hello from fake provider",
        "Continue from here. Do not repeat completed work.",
      ].join("\n"),
    )

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

    // handoff 只作用于切换后的第一次消息，避免后续每轮重复注入。
    const third = await ctx.providers.startRun(thread.id, "again")
    await third.done
    expect(claude.inputs[1]).toEqual({ text: "again" })
    await ctx.fiber.dispose()
  })

  it("puts the handoff before the user text in the Claude prompt", async () => {
    const prompts: string[] = []
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
