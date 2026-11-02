/** 验证 agent 设置如何流到 driver：检测、模型目录（含自定义模型）、新会话、默认 agent 与注销清理。 */
import { Context } from "cordis"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { AgentStatus } from "@pigcode/contracts"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings, loadSettingsFile } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import {
  createDetectionCache,
  forcedAgentId,
  normalizeAgentSettings,
  pickDefaultAgent,
} from "./agent-settings"
import type { CreateSessionInput, AgentDriver } from "./driver"
import { FakeAgentDriver } from "./fake"
import { apply as agentsPlugin } from "./registry"

async function setup(options: { fake?: boolean; settingsPath?: string } = {}) {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(settings, options.settingsPath ? { path: options.settingsPath } : {})
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agentsPlugin, options.fake === undefined ? {} : { fake: options.fake })
  return ctx
}

/** 记录每次调用拿到的设置；send 立即完成。 */
function recordingDriver(id: string, status: Partial<AgentStatus> = {}) {
  const calls = {
    detect: [] as unknown[],
    models: [] as unknown[],
    sessions: [] as CreateSessionInput[],
  }
  const driver: AgentDriver = {
    id,
    displayName: id.toUpperCase(),
    features: new FakeAgentDriver().features,
    detect: vi.fn(async (values) => {
      calls.detect.push(values)
      return { installed: true, version: "1.0.0", authenticated: true, ...status }
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

describe("agent catalog", () => {
  it("passes the saved settings to detection, model listing and new sessions", async () => {
    const ctx = await setup()
    const { driver, calls } = recordingDriver("alpha")
    ctx.agents.register(driver)
    const saved = ctx.agents.updateSettings("alpha", {
      binaryPath: "/opt/alpha",
      launchArgs: "   ",
      customModels: [" alpha-preview ", "alpha-base", "alpha-preview"],
    })
    // 留空的项去掉，自定义模型去空白、去重。
    expect(saved).toEqual({
      binaryPath: "/opt/alpha",
      customModels: ["alpha-preview", "alpha-base"],
    })

    await expect(ctx.agents.detect({ agentId: "alpha" })).resolves.toMatchObject({
      alpha: { installed: true, version: "1.0.0" },
    })
    expect(calls.detect.at(-1)).toEqual(saved)

    const models = await ctx.agents.models("alpha")
    expect(models.map((model) => [model.id, model.custom === true])).toEqual([
      ["alpha-base", false],
      ["alpha-preview", true],
    ])
    expect(calls.models.at(-1)).toEqual(saved)

    const project = ctx.projects.add("/tmp/pigcode-agent-catalog")
    const thread = ctx.threads.create(project.id, "Alpha", "alpha")
    const { done } = await ctx.agents.startRun(thread.id, "hi")
    await done
    expect(calls.sessions.at(-1)?.settings).toEqual(saved)
    await ctx.fiber.dispose()
  })

  it("re-reads detection and the catalog after settings change", async () => {
    const ctx = await setup()
    const { driver, calls } = recordingDriver("alpha")
    ctx.agents.register(driver)
    await ctx.agents.detect()
    await ctx.agents.detect()
    expect(calls.detect).toHaveLength(1)
    await ctx.agents.models("alpha")
    await ctx.agents.models("alpha")
    expect(calls.models).toHaveLength(1)

    ctx.agents.updateSettings("alpha", { binaryPath: "/new/alpha" })
    await ctx.agents.detect()
    await ctx.agents.models("alpha")
    expect(calls.detect).toHaveLength(2)
    expect(calls.models).toHaveLength(2)
    await ctx.agents.detect({ refresh: true })
    expect(calls.detect).toHaveLength(3)
    await ctx.fiber.dispose()
  })

  it("persists settings and the default agent across restarts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pigcode-settings-"))
    const settingsPath = join(dir, "settings.json")
    const first = await setup({ settingsPath })
    first.agents.register(recordingDriver("alpha").driver)
    first.agents.updateSettings("alpha", { binaryPath: "/opt/alpha" })
    first.agents.setDefaultAgent("alpha")
    await first.fiber.dispose()

    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      "agents.alpha": { binaryPath: "/opt/alpha" },
      defaultAgent: "alpha",
    })
    const second = await setup({ settingsPath })
    second.agents.register(recordingDriver("alpha").driver)
    expect(second.agents.getSettings("alpha")).toEqual({ binaryPath: "/opt/alpha" })
    expect(second.agents.configuredDefaultAgent()).toBe("alpha")
    await expect(second.agents.defaultAgent()).resolves.toBe("alpha")
    // 清空设置时删除这个键，而不是存一个空对象。
    second.agents.updateSettings("alpha", { binaryPath: "" })
    expect(second.settings.snapshot()).not.toHaveProperty("agents.alpha")
    await second.fiber.dispose()
  })

  it("backs up a corrupt settings file and starts empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pigcode-settings-"))
    const path = join(dir, "settings.json")
    await writeFile(path, "{ not json")
    expect(loadSettingsFile(path)).toEqual({})
    await expect(readFile(path, "utf8")).rejects.toThrow()
  })

  it("does not register the fake agent when the profile turns it off", async () => {
    const ctx = await setup({ fake: false })
    expect(ctx.agents.list()).toEqual([])
    await expect(ctx.agents.defaultAgent()).resolves.toBeNull()
    await ctx.fiber.dispose()
  })

  it("interrupts runs and disposes sessions when a driver is unregistered", async () => {
    const ctx = await setup()
    let release: () => void = () => undefined
    const dispose = vi.fn(async () => undefined)
    const { driver } = recordingDriver("alpha")
    ctx.agents.register({
      ...driver,
      send: async (_session, _input, runtime) => {
        runtime.emit({ type: "run.started" })
        await new Promise<void>((resolve) => {
          release = resolve
        })
      },
      dispose,
    })
    const project = ctx.projects.add("/tmp/pigcode-agent-unregister")
    const thread = ctx.threads.create(project.id, "Alpha", "alpha")
    const { runId, done } = await ctx.agents.startRun(thread.id, "work")
    ctx.agents.unregister("alpha")
    await done
    expect(ctx.agents.getRunStatus(runId)).toBe("interrupted")
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(ctx.agents.list().map((item) => item.id)).not.toContain("alpha")
    release()
    await ctx.fiber.dispose()
  })
})

describe("default agent", () => {
  const status = (installed: boolean, authenticated: boolean | null): AgentStatus => ({
    installed,
    version: null,
    authenticated,
  })

  it("prefers forced, then configured, then the first ready agent", async () => {
    const statuses: Record<string, AgentStatus> = {
      claude: status(true, false),
      codex: status(true, true),
      echo: status(true, null),
    }
    const input = {
      registered: ["fake", "claude", "codex", "echo"],
      forced: undefined,
      configured: undefined,
      status: async (id: string) => statuses[id]!,
    }
    await expect(pickDefaultAgent(input)).resolves.toBe("codex")
    await expect(pickDefaultAgent({ ...input, configured: "echo" })).resolves.toBe("echo")
    await expect(pickDefaultAgent({ ...input, configured: "gone" })).resolves.toBe("codex")
    await expect(pickDefaultAgent({ ...input, forced: "fake", configured: "echo" })).resolves.toBe(
      "fake",
    )
    statuses.codex = status(false, null)
    statuses.echo = status(false, null)
    // 都没装好时用第一个真实 agent，而不是 fake。
    await expect(pickDefaultAgent(input)).resolves.toBe("claude")
    await expect(pickDefaultAgent({ ...input, registered: ["fake"] })).resolves.toBe("fake")
    await expect(pickDefaultAgent({ ...input, registered: [] })).resolves.toBeNull()
  })

  it("reads the forced agent from PIGCODE_AGENT before the old PIGCODE_PROVIDER", () => {
    expect(forcedAgentId({})).toBeUndefined()
    expect(forcedAgentId({ PIGCODE_PROVIDER: "codex" })).toBe("codex")
    expect(forcedAgentId({ PIGCODE_AGENT: "claude" })).toBe("claude")
    expect(forcedAgentId({ PIGCODE_AGENT: "claude", PIGCODE_PROVIDER: "codex" })).toBe("claude")
    // 空值当作没设。
    expect(forcedAgentId({ PIGCODE_AGENT: "", PIGCODE_PROVIDER: "codex" })).toBe("codex")
    expect(forcedAgentId({ PIGCODE_AGENT: "", PIGCODE_PROVIDER: "" })).toBeUndefined()
  })

  it("forces the default agent and the fake agent through PIGCODE_AGENT", async () => {
    vi.stubEnv("PIGCODE_PROVIDER", "codex")
    vi.stubEnv("PIGCODE_AGENT", "fake")
    try {
      // 随应用发布的 profile 不注册 fake；PIGCODE_AGENT=fake 重新打开它，并压过 PIGCODE_PROVIDER。
      const ctx = await setup({ fake: false })
      ctx.agents.register(recordingDriver("codex").driver)
      expect(ctx.agents.list().map((driver) => driver.id)).toEqual(["fake", "codex"])
      await expect(ctx.agents.defaultAgent()).resolves.toBe("fake")
      vi.stubEnv("PIGCODE_AGENT", "")
      await expect(ctx.agents.defaultAgent()).resolves.toBe("codex")
      await ctx.fiber.dispose()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("rejects malformed custom models", () => {
    expect(() => normalizeAgentSettings({ customModels: "gpt-6" })).toThrow("customModels")
  })

  it("shares one in-flight detection and reports failures as not installed", async () => {
    const cache = createDetectionCache()
    const load = vi.fn(async () => status(true, true))
    await Promise.all([cache.get("a", load), cache.get("a", load)])
    expect(load).toHaveBeenCalledTimes(1)
    await expect(cache.get("b", async () => Promise.reject(new Error("boom")))).resolves.toEqual({
      installed: false,
      version: null,
      authenticated: null,
      error: "boom",
    })
  })
})
