/** 验证 agent 设置如何流到 driver：检测、模型目录（含自定义模型）、新会话、默认 agent 与注销清理。 */
import { Context } from "cordis"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { ProviderStatus } from "@pigcode/contracts"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings, loadSettingsFile } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import {
  createDetectionCache,
  forcedAgentId,
  normalizeProviderSettings,
  pickDefaultProvider,
} from "./agent-settings"
import type { CreateSessionInput, ProviderDriver } from "./driver"
import { FakeProviderDriver } from "./fake"
import { apply as providers } from "./registry"

async function setup(options: { fake?: boolean; settingsPath?: string } = {}) {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(settings, options.settingsPath ? { path: options.settingsPath } : {})
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(providers, options.fake === undefined ? {} : { fake: options.fake })
  return ctx
}

/** 记录每次调用拿到的设置；send 立即完成。 */
function recordingDriver(id: string, status: Partial<ProviderStatus> = {}) {
  const calls = {
    detect: [] as unknown[],
    models: [] as unknown[],
    sessions: [] as CreateSessionInput[],
  }
  const driver: ProviderDriver = {
    id,
    displayName: id.toUpperCase(),
    capabilities: new FakeProviderDriver().capabilities,
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
    ctx.providers.register(driver)
    const saved = ctx.providers.updateSettings("alpha", {
      binaryPath: "/opt/alpha",
      launchArgs: "   ",
      customModels: [" alpha-preview ", "alpha-base", "alpha-preview"],
    })
    // 留空的项去掉，自定义模型去空白、去重。
    expect(saved).toEqual({
      binaryPath: "/opt/alpha",
      customModels: ["alpha-preview", "alpha-base"],
    })

    await expect(ctx.providers.detect({ providerId: "alpha" })).resolves.toMatchObject({
      alpha: { installed: true, version: "1.0.0" },
    })
    expect(calls.detect.at(-1)).toEqual(saved)

    const models = await ctx.providers.models("alpha")
    expect(models.map((model) => [model.id, model.custom === true])).toEqual([
      ["alpha-base", false],
      ["alpha-preview", true],
    ])
    expect(calls.models.at(-1)).toEqual(saved)

    const project = ctx.projects.add("/tmp/pigcode-agent-catalog")
    const thread = ctx.threads.create(project.id, "Alpha", "alpha")
    const { done } = await ctx.providers.startRun(thread.id, "hi")
    await done
    expect(calls.sessions.at(-1)?.settings).toEqual(saved)
    await ctx.fiber.dispose()
  })

  it("re-reads detection and the catalog after settings change", async () => {
    const ctx = await setup()
    const { driver, calls } = recordingDriver("alpha")
    ctx.providers.register(driver)
    await ctx.providers.detect()
    await ctx.providers.detect()
    expect(calls.detect).toHaveLength(1)
    await ctx.providers.models("alpha")
    await ctx.providers.models("alpha")
    expect(calls.models).toHaveLength(1)

    ctx.providers.updateSettings("alpha", { binaryPath: "/new/alpha" })
    await ctx.providers.detect()
    await ctx.providers.models("alpha")
    expect(calls.detect).toHaveLength(2)
    expect(calls.models).toHaveLength(2)
    await ctx.providers.detect({ refresh: true })
    expect(calls.detect).toHaveLength(3)
    await ctx.fiber.dispose()
  })

  it("persists settings and the default agent across restarts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pigcode-settings-"))
    const settingsPath = join(dir, "settings.json")
    const first = await setup({ settingsPath })
    first.providers.register(recordingDriver("alpha").driver)
    first.providers.updateSettings("alpha", { binaryPath: "/opt/alpha" })
    first.providers.setDefaultProvider("alpha")
    await first.fiber.dispose()

    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      "providers.alpha": { binaryPath: "/opt/alpha" },
      "agents.defaultProvider": "alpha",
    })
    const second = await setup({ settingsPath })
    second.providers.register(recordingDriver("alpha").driver)
    expect(second.providers.getSettings("alpha")).toEqual({ binaryPath: "/opt/alpha" })
    expect(second.providers.configuredDefaultProvider()).toBe("alpha")
    await expect(second.providers.defaultProvider()).resolves.toBe("alpha")
    // 清空设置时删除这个键，而不是存一个空对象。
    second.providers.updateSettings("alpha", { binaryPath: "" })
    expect(second.settings.snapshot()).not.toHaveProperty("providers.alpha")
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
    expect(ctx.providers.list()).toEqual([])
    await expect(ctx.providers.defaultProvider()).resolves.toBeNull()
    await ctx.fiber.dispose()
  })

  it("interrupts runs and disposes sessions when a driver is unregistered", async () => {
    const ctx = await setup()
    let release: () => void = () => undefined
    const dispose = vi.fn(async () => undefined)
    const { driver } = recordingDriver("alpha")
    ctx.providers.register({
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
    const { runId, done } = await ctx.providers.startRun(thread.id, "work")
    ctx.providers.unregister("alpha")
    await done
    expect(ctx.providers.getRunStatus(runId)).toBe("interrupted")
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(ctx.providers.list().map((item) => item.id)).not.toContain("alpha")
    release()
    await ctx.fiber.dispose()
  })
})

describe("default agent", () => {
  const status = (installed: boolean, authenticated: boolean | null): ProviderStatus => ({
    installed,
    version: null,
    authenticated,
  })

  it("prefers forced, then configured, then the first ready agent", async () => {
    const statuses: Record<string, ProviderStatus> = {
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
    await expect(pickDefaultProvider(input)).resolves.toBe("codex")
    await expect(pickDefaultProvider({ ...input, configured: "echo" })).resolves.toBe("echo")
    await expect(pickDefaultProvider({ ...input, configured: "gone" })).resolves.toBe("codex")
    await expect(
      pickDefaultProvider({ ...input, forced: "fake", configured: "echo" }),
    ).resolves.toBe("fake")
    statuses.codex = status(false, null)
    statuses.echo = status(false, null)
    // 都没装好时用第一个真实 agent，而不是 fake。
    await expect(pickDefaultProvider(input)).resolves.toBe("claude")
    await expect(pickDefaultProvider({ ...input, registered: ["fake"] })).resolves.toBe("fake")
    await expect(pickDefaultProvider({ ...input, registered: [] })).resolves.toBeNull()
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
      ctx.providers.register(recordingDriver("codex").driver)
      expect(ctx.providers.list().map((driver) => driver.id)).toEqual(["fake", "codex"])
      await expect(ctx.providers.defaultProvider()).resolves.toBe("fake")
      vi.stubEnv("PIGCODE_AGENT", "")
      await expect(ctx.providers.defaultProvider()).resolves.toBe("codex")
      await ctx.fiber.dispose()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("rejects malformed custom models", () => {
    expect(() => normalizeProviderSettings({ customModels: "gpt-6" })).toThrow("customModels")
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
