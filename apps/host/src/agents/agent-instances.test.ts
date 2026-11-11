/**
 * Agent 实例：同一个 Agent 下的多份配置各自独立——创建时复制来源的设置，之后改一份不影响另一份；
 * 每份都有独立的检测与模型目录；默认实例不能删；会话记住的实例不存在时退回默认实例。
 */
import { Context } from "cordis"
import { describe, expect, it, vi } from "vitest"
import type { AgentStatus } from "@pigcode/contracts"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import {
  createInstance,
  listInstances,
  removeInstance,
  resolveInstance,
  updateInstance,
} from "./agent-settings"
import type { CreateSessionInput, AgentDriver } from "./driver"
import { FakeAgentDriver } from "./fake"
import { apply as agentsPlugin } from "./registry"

/** 只有存储与设置服务：验证实例本身如何存、如何解析。 */
async function settingsOnly() {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(settings, {})
  return ctx
}

/** 完整的 agents 服务：验证实例订阅的检测、模型与会话。 */
async function setup() {
  const ctx = await settingsOnly()
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agentsPlugin, { fake: false })
  return ctx
}

/** 记录每次调用拿到的设置；send 立即完成。 */
function recordingDriver(id: string) {
  const calls = {
    detect: [] as unknown[],
    models: [] as unknown[],
    sessions: [] as CreateSessionInput[],
  }
  const driver: AgentDriver = {
    id,
    displayName: "Alpha",
    features: new FakeAgentDriver().features,
    detect: vi.fn(async (values) => {
      calls.detect.push(values)
      return { installed: true, version: "1.0.0", authenticated: true } satisfies AgentStatus
    }),
    listModels: vi.fn(async (values) => {
      calls.models.push(values)
      return [{ id: `${id}-base`, displayName: "Base", isDefault: true }]
    }),
    createSession: async (input) => {
      calls.sessions.push(input)
      return {
        id: `ps_${id}`,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: null,
        permissionMode: "workspace-write",
        model: input.model ?? null,
      }
    },
    send: async (_session, _input, runtime) => runtime.emit({ type: "run.completed" }),
    interrupt: async () => undefined,
    dispose: async () => undefined,
  }
  return { driver, calls }
}

describe("agent instances", () => {
  it("creates an instance from a copy and keeps the two independent", async () => {
    const ctx = await settingsOnly()
    const store = ctx.settings
    store.set("agents.alpha", { binaryPath: "/opt/alpha" })

    const created = createInstance(store, "alpha", "公司 API", null)
    expect(created.instanceId).toMatch(/^inst_/)
    expect(created.values).toEqual({ binaryPath: "/opt/alpha" })
    expect(created.isDefault).toBe(false)

    // 改新实例的值不影响默认实例。
    updateInstance(store, created.instanceId, { values: { binaryPath: "/opt/work" } })
    expect(resolveInstance(store, "alpha").values).toEqual({ binaryPath: "/opt/alpha" })
    expect(resolveInstance(store, "alpha", created.instanceId).values).toEqual({
      binaryPath: "/opt/work",
    })

    // 默认实例排在最前，名字用 agent 的显示名。
    expect(listInstances(store, "alpha", "Alpha").map((item) => item.instanceId)).toEqual([
      "alpha",
      created.instanceId,
    ])
    await ctx.fiber.dispose()
  })

  it("refuses to remove or edit the default instance", async () => {
    const ctx = await settingsOnly()
    expect(() => removeInstance(ctx.settings, "alpha")).toThrow("default instance")
    expect(() => updateInstance(ctx.settings, "alpha", { label: "x" })).toThrow("default instance")
    await ctx.fiber.dispose()
  })

  it("falls back to the default instance when the thread remembers a removed one", async () => {
    const ctx = await settingsOnly()
    const store = ctx.settings
    store.set("agents.alpha", { binaryPath: "/opt/alpha" })
    const created = createInstance(store, "alpha", "公司 API", null)
    removeInstance(store, created.instanceId)
    expect(resolveInstance(store, "alpha", created.instanceId).instanceId).toBe("alpha")
    await ctx.fiber.dispose()
  })

  it("detects and lists models per instance, using its own settings", async () => {
    const ctx = await setup()
    const { driver, calls } = recordingDriver("alpha")
    ctx.agents.register(driver)
    ctx.agents.updateSettings("alpha", { binaryPath: "/opt/alpha" })
    const created = ctx.agents.createInstance("alpha", "公司 API")
    ctx.agents.updateSettings("alpha", { binaryPath: "/opt/work" }, created.instanceId)

    await expect(ctx.agents.detect()).resolves.toMatchObject({
      alpha: { installed: true },
      [created.instanceId]: { installed: true },
    })
    // 每个实例各自检测一次，拿到的是自己那份设置。
    expect(calls.detect).toEqual([{ binaryPath: "/opt/alpha" }, { binaryPath: "/opt/work" }])

    await ctx.agents.models("alpha", created.instanceId)
    expect(calls.models.at(-1)).toEqual({ binaryPath: "/opt/work" })
    await ctx.fiber.dispose()
  })

  it("defaults a new session to the chosen instance and starts the run with it", async () => {
    const ctx = await setup()
    const { driver, calls } = recordingDriver("alpha")
    ctx.agents.register(driver)
    const created = ctx.agents.createInstance("alpha", "公司 API")
    ctx.agents.updateSettings("alpha", { binaryPath: "/opt/work" }, created.instanceId)
    ctx.agents.setDefaultAgent("alpha", created.instanceId)

    await expect(ctx.agents.defaultAgent()).resolves.toEqual({
      agentId: "alpha",
      instanceId: created.instanceId,
    })
    const project = ctx.projects.add("/tmp/pigcode-instances")
    const { done } = await ctx.agents.startRun(
      ctx.threads.create(project.id, "Work", "alpha").id,
      "hi",
      undefined,
      { instanceId: created.instanceId },
    )
    await done
    expect(calls.sessions.at(-1)?.settings).toEqual({ binaryPath: "/opt/work" })
    await ctx.fiber.dispose()
  })

  it("falls back to the default instance when the chosen default is removed", async () => {
    const ctx = await setup()
    ctx.agents.register(recordingDriver("alpha").driver)
    const created = ctx.agents.createInstance("alpha", "公司 API")
    ctx.agents.setDefaultAgent("alpha", created.instanceId)
    ctx.agents.removeInstance(created.instanceId)
    await expect(ctx.agents.defaultAgent()).resolves.toEqual({
      agentId: "alpha",
      instanceId: "alpha",
    })
    expect(ctx.agents.configuredDefaultInstance()).toBeNull()
    await ctx.fiber.dispose()
  })

  it("reports instances with their own label and enabled flag", async () => {
    const ctx = await setup()
    ctx.agents.register(recordingDriver("alpha").driver)
    const created = ctx.agents.createInstance("alpha", "公司 API")
    ctx.agents.updateInstance(created.instanceId, { enabled: false })
    const [listed] = ctx.agents.listInstances("alpha")
    expect(listed?.instanceId).toBe("alpha")
    expect(listed?.isDefault).toBe(true)
    expect(ctx.agents.findInstance(created.instanceId)).toMatchObject({
      label: "公司 API",
      enabled: false,
    })
    await ctx.fiber.dispose()
  })

  it("forks a session from another instance that keeps its sessions in the same place", async () => {
    const ctx = await setup()
    const created: CreateSessionInput[] = []
    const inputs: Array<{ text: string; handoff?: string | undefined }> = []
    let next = 0
    const driver: AgentDriver = {
      id: "alpha",
      displayName: "alpha",
      features: new FakeAgentDriver().features,
      async createSession(input) {
        created.push(input)
        return {
          id: input.sessionId ?? `s_${(next += 1)}`,
          threadId: input.threadId,
          cwd: input.cwd,
          nativeSessionId: input.nativeSessionId ?? null,
          permissionMode: "workspace-write",
          model: null,
        }
      },
      async send(session, input, runtime) {
        inputs.push(input)
        session.nativeSessionId ??= `native_${created.length}`
        runtime.emit({ type: "session.started", nativeSessionId: session.nativeSessionId })
        runtime.emit({ type: "message.completed", text: `reply to ${input.text}` })
        runtime.emit({ type: "run.completed" })
      },
      interrupt: async () => undefined,
      dispose: async () => undefined,
      continuationKey: (settings) => `alpha:${String(settings.configDir ?? "~/.alpha")}`,
    }
    ctx.agents.register(driver)
    const same = ctx.agents.createInstance("alpha", "同一目录")
    const other = ctx.agents.createInstance("alpha", "另一个目录")
    ctx.agents.updateSettings("alpha", { configDir: "/elsewhere" }, other.instanceId)
    const project = ctx.projects.add("/tmp/pigcode-shared-instances")
    const thread = ctx.threads.create(project.id, "T", "alpha")
    const run = async (text: string) => (await ctx.agents.startRun(thread.id, text)).done

    await run("plan the parser")
    // 配置目录相同：fork 默认实例的原生会话，没有新的东西可交接。
    const toSame = await ctx.agents.switchAgent(thread.id, "alpha", null, same.instanceId)
    expect(toSame.forkFromNativeSessionId).toBe("native_1")
    expect(toSame.handoff).toBeNull()
    await run("write it")
    expect(created.at(-1)).toMatchObject({ forkFromNativeSessionId: "native_1" })
    expect(inputs.at(-1)?.handoff).toBeUndefined()

    // 配置目录不同：接不上，交接整个会话。
    const toOther = await ctx.agents.switchAgent(thread.id, "alpha", null, other.instanceId)
    expect(toOther.forkFromNativeSessionId).toBeNull()
    expect(toOther.handoff).toContain("plan the parser")
    expect(toOther.handoff).toContain("write it")
    await ctx.fiber.dispose()
  })
})
