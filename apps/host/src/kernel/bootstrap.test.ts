/** 验证 Host 公共引导层：运行时 profile 定位、核心服务启动、提醒绑定、幂等释放与失败清理。 */
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { bootstrapHostKernel, resolveHostRuntimeRoot } from "./bootstrap"

const dirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pigcode-bootstrap-"))
  dirs.push(dir)
  return dir
}

describe("resolveHostRuntimeRoot", () => {
  it("prefers PIGCODE_CORE_PROFILE_DIR when set and non-empty", async () => {
    const root = await makeTempDir()
    const envDir = join(root, "custom-core")
    expect(
      resolveHostRuntimeRoot(pathToFileURL(join(root, "index.mjs")).href, {
        PIGCODE_CORE_PROFILE_DIR: `  ${envDir}  `,
      }),
    ).toBe(envDir)
  })

  it("finds desktop.yml across built bundle, src entry, and src/kernel locations, or falls back", async () => {
    const root = await makeTempDir()

    const bundleDir = join(root, "bundle")
    await mkdir(join(bundleDir, "profile"), { recursive: true })
    await writeFile(join(bundleDir, "profile", "desktop.yml"), "plugins: []\n")
    expect(resolveHostRuntimeRoot(pathToFileURL(join(bundleDir, "index.mjs")).href, {})).toBe(
      join(bundleDir, "profile"),
    )

    const repoDir = join(root, "repo")
    const outProfile = join(repoDir, "apps", "desktop", "out", "host", "profile")
    await mkdir(outProfile, { recursive: true })
    await writeFile(join(outProfile, "desktop.yml"), "plugins: []\n")

    expect(
      resolveHostRuntimeRoot(
        pathToFileURL(join(repoDir, "apps", "host", "src", "entry.ts")).href,
        {},
      ),
    ).toBe(outProfile)

    expect(
      resolveHostRuntimeRoot(
        pathToFileURL(join(repoDir, "apps", "host", "src", "kernel", "bootstrap.ts")).href,
        {},
      ),
    ).toBe(outProfile)

    const emptyDir = join(root, "empty")
    expect(resolveHostRuntimeRoot(pathToFileURL(join(emptyDir, "index.mjs")).href, {})).toBe(
      join(emptyDir, "profile"),
    )
  })
})

async function writeMinimalRuntimeProfile(
  runtimeRoot: string,
  options: { failStorage?: boolean } = {},
): Promise<string> {
  const statePath = join(runtimeRoot, "state.json")
  await writeFile(
    statePath,
    JSON.stringify({
      configs: {},
      recovered: false,
      schedulesStarted: false,
      disposed: [],
    }),
    "utf8",
  )

  await writeFile(
    join(runtimeRoot, "fixture-services.mjs"),
    `import { readFileSync, writeFileSync } from "node:fs"

function updateState(fn) {
  const path = ${JSON.stringify(statePath)}
  const state = JSON.parse(readFileSync(path, "utf8"))
  fn(state)
  writeFileSync(path, JSON.stringify(state), "utf8")
}

export function createStorage(ctx, config) {
  updateState((s) => { s.configs.storage = config })
  ${options.failStorage ? 'throw new Error("boom")' : ""}
  ctx.provide("storage", { db: {}, events: {}, receipts: {} })
  ctx.effect(() => () => updateState((s) => { s.disposed.push("storage") }))
}

export function createSettings(ctx, config) {
  updateState((s) => { s.configs.settings = config })
  ctx.provide("settings", {
    get: () => undefined,
    set: () => undefined,
    snapshot: () => ({}),
    onChange: () => () => undefined,
  })
  ctx.effect(() => () => updateState((s) => { s.disposed.push("settings") }))
}

export function createCoreRest(ctx) {
  const listeners = new Set()
  ctx.provide("projects", { list: () => [{ id: "p1" }] })
  ctx.provide("threads", {
    get: (id) => ({
      id,
      projectId: "p1",
      parentThreadId: null,
      archivedAt: null,
      lastRunId: "r1",
      unread: true,
    }),
  })
  ctx.provide("sessions", {
    subscribeAll: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emitTestEvent: (event) => {
      for (const listener of [...listeners]) listener(event)
    },
  })
  ctx.provide("attachments", {})
  ctx.effect(() => () => updateState((s) => { s.disposed.push("rest") }))
}

export function createAgents(ctx, config) {
  updateState((s) => { s.configs.agents = config })
  ctx.provide("agents", {
    recoverAfterRestart: () => updateState((s) => { s.recovered = true }),
    listPendingRequests: () => [],
    getRunStatus: () => "failed",
  })
  ctx.effect(() => () => updateState((s) => { s.disposed.push("agents") }))
}

export function createSchedules(ctx) {
  ctx.provide("schedules", {
    start: () => updateState((s) => { s.schedulesStarted = true }),
  })
  ctx.effect(() => () => updateState((s) => { s.disposed.push("schedules") }))
}
`,
    "utf8",
  )

  const writeWrapper = async (file: string, fn: string) => {
    await writeFile(
      join(runtimeRoot, file),
      `export { ${fn} as apply } from "./fixture-services.mjs"\n`,
      "utf8",
    )
  }

  await Promise.all([
    writeWrapper("settings.mjs", "createSettings"),
    writeWrapper("storage.mjs", "createStorage"),
    writeWrapper("rest.mjs", "createCoreRest"),
    writeWrapper("agents.mjs", "createAgents"),
    writeWrapper("schedules.mjs", "createSchedules"),
  ])

  await writeFile(
    join(runtimeRoot, "desktop.yml"),
    [
      "plugins:",
      "  - id: core.settings",
      "    name: ./settings.mjs",
      "  - id: core.storage",
      "    name: ./storage.mjs",
      "  - id: core.rest",
      "    name: ./rest.mjs",
      "  - id: core.agents",
      "    name: ./agents.mjs",
      "  - id: core.schedules",
      "    name: ./schedules.mjs",
      "",
    ].join("\n"),
    "utf8",
  )

  return statePath
}

describe("bootstrapHostKernel", () => {
  it("boots kernel, overrides config, wires reminders, and disposes idempotently", async () => {
    const root = await makeTempDir()
    const profileDir = join(root, "user-profile")
    const runtimeRoot = join(root, "runtime")
    await mkdir(runtimeRoot, { recursive: true })
    const statePath = await writeMinimalRuntimeProfile(runtimeRoot)
    const reminders: unknown[] = []

    const host = await bootstrapHostKernel({
      profileDir,
      profileName: "desktop",
      runtimeRoot,
      lanPort: false,
      onReminder: (reminder) => reminders.push(reminder),
    })

    if (process.platform !== "win32") {
      expect((await stat(profileDir)).mode & 0o777).toBe(0o700)
    }
    expect(existsSync(join(profileDir, "boot.json"))).toBe(true)
    expect(host.ctx.get("relaySettings")).toBe(host.relay)
    expect(host.ctx.get("mobileConnections")).toBe(host.mobile)

    const stateBefore = JSON.parse(await readFile(statePath, "utf8")) as {
      configs: Record<string, Record<string, unknown>>
      recovered: boolean
      schedulesStarted: boolean
      disposed: string[]
    }
    expect(stateBefore.configs.storage).toEqual({ path: join(profileDir, "pigcode.db") })
    expect(stateBefore.configs.settings).toEqual({ path: join(profileDir, "settings.json") })
    expect(stateBefore.configs.agents).toEqual({
      fake: process.env.PIGCODE_AGENT === "fake",
      dataDir: join(profileDir, "agents"),
    })
    expect(stateBefore.recovered).toBe(true)
    expect(stateBefore.schedulesStarted).toBe(true)

    const sessions = host.ctx.sessions as unknown as {
      emitTestEvent: (event: Record<string, unknown>) => void
    }
    sessions.emitTestEvent({
      seq: 1,
      threadId: "t1",
      runId: "r1",
      type: "run.failed",
      payload: { error: "boom" },
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    })
    expect(reminders).toEqual([
      { version: 1, eventId: "result:r1", threadId: "t1", kind: "failed" },
    ])

    const announceSpy = vi.spyOn(host.mobile, "announceExit")
    const mobileDisposeSpy = vi.spyOn(host.mobile, "dispose")

    await host.dispose("exited")
    await host.dispose("restarting")

    expect(announceSpy).toHaveBeenCalledTimes(1)
    expect(announceSpy).toHaveBeenCalledWith("exited")
    expect(mobileDisposeSpy).toHaveBeenCalledTimes(1)

    const stateAfter = JSON.parse(await readFile(statePath, "utf8")) as { disposed: string[] }
    expect(stateAfter.disposed).toContain("settings")
    expect(stateAfter.disposed).toContain("agents")
  })

  it("cleans up mounted services when initialization fails mid-boot", async () => {
    const root = await makeTempDir()
    const profileDir = join(root, "user-profile")
    const runtimeRoot = join(root, "runtime")
    await mkdir(runtimeRoot, { recursive: true })
    const statePath = await writeMinimalRuntimeProfile(runtimeRoot, { failStorage: true })

    await expect(
      bootstrapHostKernel({
        profileDir,
        runtimeRoot,
        lanPort: false,
      }),
    ).rejects.toThrow("core.storage failed to start: boom")

    const stateAfter = JSON.parse(await readFile(statePath, "utf8")) as { disposed: string[] }
    expect(stateAfter.disposed).toContain("settings")
  })
})
