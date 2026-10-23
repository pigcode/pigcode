/** 验证输入框里的 agent 选项走到 Host：模型目录、思考深度、权限模式与首次切换不带 handoff。 */
import type { ProviderModel } from "@pigcode/contracts"
import { Context } from "cordis"
import { describe, expect, it, vi } from "vitest"
import type { ProviderDriver, UserInput } from "../providers/driver"
import { apply as providers } from "../providers/registry"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { MemoryTransport } from "./memory-transport"
import { RpcServer } from "./server"

/** 记录每次 send 收到的输入与会话权限的 driver。 */
function recordingDriver(listModels: () => Promise<ProviderModel[]>) {
  const inputs: UserInput[] = []
  const modes: string[] = []
  const driver: ProviderDriver = {
    id: "rec",
    displayName: "Recorder",
    capabilities: {
      streaming: true,
      approvals: false,
      questions: false,
      plan: true,
      resume: false,
      fork: false,
      rollback: false,
      checkpoint: false,
      subagents: false,
      mcp: false,
      images: false,
      usage: false,
      modelCatalog: true,
      nativeSessionId: false,
    },
    async createSession(input) {
      return {
        id: `rec_${input.threadId}`,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: null,
        permissionMode: input.permissionMode ?? "workspace-write",
        model: input.model ?? null,
      }
    },
    async send(session, input, runtime) {
      inputs.push(input)
      modes.push(session.permissionMode)
      runtime.emit({ type: "message.completed", text: "ok" })
    },
    async interrupt() {},
    async dispose() {},
    listModels,
  }
  return { driver, inputs, modes }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(providers)
  const transport = new MemoryTransport()
  new RpcServer(ctx, transport.host).start()
  const project = ctx.projects.add("/tmp/pigcode-agent-options")
  let id = 0
  const call = async (method: string, params: unknown) => {
    id += 1
    transport.client.send({ jsonrpc: "2.0", id: String(id), method, params })
    for (;;) {
      const message = (await transport.client.next()) as {
        id?: string
        result?: unknown
        error?: { message: string }
      }
      if (message.id !== String(id)) continue
      if (message.error) throw new Error(message.error.message)
      return message.result
    }
  }
  return { ctx, project, call }
}

const SAGE: ProviderModel = {
  id: "sage",
  displayName: "Sage",
  isDefault: true,
  efforts: ["low", "high"],
  defaultEffort: "low",
}

describe("agent options over RPC", () => {
  it("serves a normalized, cached model catalog per agent", async () => {
    const { ctx, call } = await setup()
    const listModels = vi.fn(async () => [SAGE, { ...SAGE, displayName: "dup" }])
    ctx.providers.register(recordingDriver(listModels).driver)

    await expect(call("provider.models", { providerId: "rec" })).resolves.toEqual([SAGE])
    await call("provider.models", { providerId: "rec" })
    expect(listModels).toHaveBeenCalledTimes(1)
    // 重新注册（插件重载）后目录重新读取。
    ctx.providers.register(recordingDriver(listModels).driver)
    await call("provider.models", { providerId: "rec" })
    expect(listModels).toHaveBeenCalledTimes(2)
    await ctx.fiber.dispose()
  })

  it("passes the run's effort to the agent and applies a new permission mode to the next run", async () => {
    const { ctx, project, call } = await setup()
    const recorder = recordingDriver(async () => [SAGE])
    ctx.providers.register(recorder.driver)
    const thread = ctx.threads.create(project.id, "Options", "rec")

    const first = (await call("run.start", {
      threadId: thread.id,
      text: "go",
      effort: "high",
    })) as {
      runId: string
    }
    expect(first.runId).toMatch(/^run_/)
    await vi.waitFor(() => expect(recorder.inputs).toHaveLength(1))
    expect(recorder.inputs[0]).toEqual({ text: "go", effort: "high" })
    expect(recorder.modes[0]).toBe("workspace-write")

    await expect(
      call("thread.setPermissionMode", { threadId: thread.id, permissionMode: "plan" }),
    ).resolves.toMatchObject({ id: thread.id, permissionMode: "plan" })
    expect(ctx.threads.get(thread.id)?.permissionMode).toBe("plan")
    const updated = ctx.sessions
      .read(thread.id, 0)
      .filter((event) => event.type === "thread.updated")
      .at(-1)
    expect(updated?.payload).toEqual({ permissionMode: "plan" })

    await vi.waitFor(() => expect(ctx.providers.listRuns()).toHaveLength(0))
    await call("run.start", { threadId: thread.id, text: "again" })
    await vi.waitFor(() => expect(recorder.inputs).toHaveLength(2))
    expect(recorder.inputs[1]).toEqual({ text: "again" })
    expect(recorder.modes[1]).toBe("plan")

    await expect(
      call("thread.setPermissionMode", { threadId: thread.id, permissionMode: "yolo" }),
    ).rejects.toThrow()
    await ctx.fiber.dispose()
  })

  it("does not hand off an empty conversation when the agent changes before the first message", async () => {
    const { ctx, project, call } = await setup()
    const recorder = recordingDriver(async () => [SAGE])
    ctx.providers.register(recorder.driver)
    const thread = ctx.threads.create(project.id, "Fresh", "fake")

    const switched = (await call("thread.switchProvider", {
      threadId: thread.id,
      providerId: "rec",
      modelId: "sage",
    })) as { handoff: string | null }
    expect(switched.handoff).toBeNull()

    await call("run.start", { threadId: thread.id, text: "first message" })
    await vi.waitFor(() => expect(recorder.inputs).toHaveLength(1))
    expect(recorder.inputs[0]).toEqual({ text: "first message" })
    await ctx.fiber.dispose()
  })
})
