import { mkdtemp, readFile, rename, rm } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { Context } from "cordis"
import { expect, it } from "vitest"
import { AntigravityDriver } from "../../../../packages/agent-antigravity/src/driver"
import { apply as projects } from "../services/projects"
import { apply as mcpBridge } from "../services/mcp-bridge"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { apply as agents } from "./registry"
import { writeAgyFixture } from "./fixtures/executable"

it("uses the current signed-in CLI on PATH and keeps separate instances independent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pigcode-agy-path-test-"))
  const cli = writeAgyFixture(root)
  if (process.platform !== "win32") await rename(cli, join(root, "agy"))
  const ctx = new Context()
  const driver = new AntigravityDriver(async (input) => {
    const { platform, arch } = process
    const os = platform === "darwin" ? "mac" : platform === "win32" ? "windows" : platform
    const family = platform === "win32" ? "windows" : platform
    const musl = String(input).endsWith("_musl.json")
    const folder = `${family}-${arch === "arm64" ? "arm" : "x64"}${musl ? "-musl" : ""}`
    const name = `cli_${os}_${arch}${musl ? "_musl" : ""}.${platform === "win32" ? "exe" : "tar.gz"}`
    return Response.json({
      version: "1.5.13",
      sha512: "a".repeat(128),
      url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13-1/${folder}/${name}`,
    })
  })
  try {
    await ctx.plugin(storage, { path: ":memory:" })
    await ctx.plugin(settings, {})
    await ctx.plugin(projects)
    await ctx.plugin(threads)
    await ctx.plugin(sessions)
    await ctx.plugin(agents, { fake: false, dataDir: join(root, "agent-data") })
    ctx.agents.register(driver)
    ctx.agents.updateSettings("antigravity", {
      environment: [
        { name: "PATH", value: [root, process.env.PATH].join(delimiter) },
        { name: "PIGCODE_AGY_FIXTURE_CLI_DATA", value: join(root, "cli-account") },
        { name: "SSH_CONNECTION", value: "" },
      ],
    })
    const work = ctx.agents.createInstance("antigravity", "Work")

    const [status, models, updates] = await Promise.all([
      ctx.agents.detect({ refresh: true }),
      ctx.agents.models("antigravity"),
      ctx.agents.checkCliUpdates("antigravity"),
    ])
    expect.soft(status).toMatchObject({
      antigravity: { installed: true, version: "1.5.13", authenticated: true, usingCliLogin: true },
      [work.instanceId]: { installed: true, authenticated: false },
    })
    expect.soft(models).toMatchObject([{ id: "cli-model" }])
    expect.soft(updates.antigravity).toMatchObject({
      currentVersion: "1.5.13",
      latestVersion: "1.5.13",
      available: false,
    })
    const thread = ctx.threads.create(ctx.projects.add(root).id, "CLI", "antigravity")
    await (
      await ctx.agents.startRun(thread.id, "hello")
    ).done
    expect(ctx.sessions.read(thread.id, 0)).toContainEqual(
      expect.objectContaining({
        type: "message.completed",
        payload: { role: "assistant", text: "cli: hello" },
      }),
    )
    const login = await ctx.agents.auth("antigravity", { action: "start" })
    await expect
      .poll(() => ctx.agents.auth("antigravity", { action: "status" }))
      .toMatchObject({ phase: "waiting" })
    await ctx.agents.auth("antigravity", {
      action: "submit",
      flowId: login.flowId!,
      response: "personal",
    })
    await expect
      .poll(() => ctx.agents.auth("antigravity", { action: "status" }))
      .toMatchObject({ phase: "connected" })
    await expect(ctx.agents.models("antigravity")).resolves.toMatchObject([
      { id: "personal-model" },
    ])
    await expect(ctx.agents.models("antigravity", work.instanceId)).resolves.toEqual([])
  } finally {
    await driver.close()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it("signs in two Antigravity instances using the same CLI and keeps their accounts separate", async () => {
  const root = await mkdtemp(join(tmpdir(), "pigcode-agy-test-"))
  const binaryPath = writeAgyFixture(root)
  const ctx = new Context()
  const driver = new AntigravityDriver()
  try {
    await ctx.plugin(storage, { path: ":memory:" })
    await ctx.plugin(settings, {})
    await ctx.plugin(projects)
    await ctx.plugin(threads)
    await ctx.plugin(sessions)
    await ctx.plugin(mcpBridge)
    await ctx.plugin(agents, { fake: false, dataDir: join(root, "agent-data") })
    ctx.agents.register(driver)
    ctx.agents.updateSettings("antigravity", { binaryPath })
    const work = ctx.agents.createInstance("antigravity", "Work")

    async function signIn(instanceId: string, response: string) {
      const started = await ctx.agents.auth(instanceId, { action: "start" })
      expect(started.flowId).toBeTruthy()
      await expect
        .poll(() => ctx.agents.auth(instanceId, { action: "status" }))
        .toMatchObject({
          phase: "waiting",
          authorizationUrl: expect.stringContaining("https://accounts.google.com/"),
        })
      await ctx.agents.auth(instanceId, { action: "submit", flowId: started.flowId!, response })
      await expect
        .poll(() => ctx.agents.auth(instanceId, { action: "status" }))
        .toMatchObject({
          phase: "connected",
        })
    }

    await signIn("antigravity", "personal")
    await signIn(work.instanceId, "work")
    await expect(ctx.agents.models("antigravity")).resolves.toMatchObject([
      { id: "personal-model" },
    ])
    await expect(ctx.agents.models("antigravity", work.instanceId)).resolves.toMatchObject([
      { id: "work-model" },
    ])
    const project = ctx.projects.add(root)
    const thread = ctx.threads.create(project.id, "Work", "antigravity", undefined, {
      instanceId: work.instanceId,
    })
    const run = await ctx.agents.startRun(thread.id, "hello")
    await run.done
    expect(ctx.sessions.read(thread.id, 0)).toContainEqual(
      expect.objectContaining({
        type: "message.completed",
        payload: { role: "assistant", text: "work: hello" },
      }),
    )
    const native = ctx.agents.listSessions(thread.id)[0]?.nativeSessionId
    await ctx.agents.switchAgent(thread.id, "antigravity", "work-model", work.instanceId)
    await (
      await ctx.agents.startRun(thread.id, "continue")
    ).done
    expect(ctx.agents.listSessions(thread.id)).toMatchObject([{ nativeSessionId: native }])

    ctx.mcp.registerTool(
      "test-fixture",
      {
        name: "fixture_context",
        description: "Read fixture context",
        inputSchema: { type: "object" },
      },
      async (_input, context) => ({ context: context.threadId }),
    )
    await (
      await ctx.agents.startRun(thread.id, "read fixture through MCP")
    ).done
    expect(ctx.sessions.read(thread.id, 0)).toContainEqual(
      expect.objectContaining({
        type: "message.completed",
        payload: { role: "assistant", text: JSON.stringify({ context: thread.id }) },
      }),
    )

    ctx.threads.setPermissionMode(thread.id, "approval-required")
    const next = await ctx.agents.startRun(thread.id, "approve and ask")
    await expect
      .poll(() => ctx.agents.listPendingRequests(thread.id).map((request) => request.kind))
      .toEqual(["approval"])
    const [approval] = ctx.agents.listPendingRequests(thread.id)
    ctx.agents.respondApproval(thread.id, next.runId, approval!.id, "allow-once")
    await expect
      .poll(() => ctx.agents.listPendingRequests(thread.id).map((request) => request.kind))
      .toEqual(["question"])
    const [question] = ctx.agents.listPendingRequests(thread.id)
    ctx.agents.answerQuestion(thread.id, next.runId, question!.id, ["Second"])
    await next.done
    expect(ctx.sessions.read(thread.id, 0)).toContainEqual(
      expect.objectContaining({
        type: "message.completed",
        payload: { role: "assistant", text: "approved: second" },
      }),
    )

    await ctx.agents.auth("antigravity", { action: "logout" })
    await expect(ctx.agents.detect({ refresh: true })).resolves.toMatchObject({
      antigravity: { authenticated: false },
      [work.instanceId]: { authenticated: true },
    })

    await ctx.agents.updateInstance("antigravity", { enabled: false })
    expect(ctx.agents.findInstance(work.instanceId)).toMatchObject({ enabled: true })
    await ctx.agents.updateInstance("antigravity", { enabled: true })

    const marker = join(root, "verifying")
    ctx.agents.updateSettings("antigravity", {
      binaryPath,
      environment: [{ name: "PIGCODE_AGY_FIXTURE_VERIFYING", value: marker }],
    })
    const pending = await ctx.agents.auth("antigravity", { action: "start" })
    await expect
      .poll(() => ctx.agents.auth("antigravity", { action: "status" }))
      .toMatchObject({ phase: "waiting" })
    await ctx.agents.auth("antigravity", {
      action: "submit",
      flowId: pending.flowId!,
      response: "pending",
    })
    await expect.poll(() => readFile(marker, "utf8").catch(() => null)).toBe("waiting")
    await ctx.agents.auth("antigravity", { action: "cancel", flowId: pending.flowId! })
    ctx.agents.unregister("antigravity")
    await driver.close()
    const restarted = new AntigravityDriver()
    ctx.agents.register(restarted)
    try {
      await expect(ctx.agents.detect({ refresh: true })).resolves.toMatchObject({
        antigravity: { authenticated: false },
        [work.instanceId]: { authenticated: true },
      })
    } finally {
      await restarted.close()
    }
  } finally {
    await driver.close()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

it.skipIf(process.platform === "win32")(
  "shares CLI installation and keeps the prior validated version after a failed update",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-agy-install-test-"))
    const archive = join(root, "agy.tar.gz")
    writeAgyFixture(root, true)
    await rename(writeAgyFixture(root, false, "1.5.12"), join(root, "agy"))
    execFileSync("tar", ["-czf", archive, "-C", root, "antigravity"])
    const bytes = await readFile(archive)
    const digest = createHash("sha512").update(bytes).digest("hex")
    let corrupt = false
    let downloads = 0
    const driver = new AntigravityDriver(async (input) => {
      if (String(input).endsWith(".json")) {
        const arch = process.arch === "arm64" ? "arm" : "x64"
        const platform = process.platform
        const version = corrupt ? "1.5.14" : "1.5.13"
        const os = platform === "darwin" ? "mac" : "linux"
        return Response.json({
          version,
          url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-1/${platform}-${arch}/cli_${os}_${process.arch}.tar.gz`,
          sha512: corrupt ? "a".repeat(128) : digest,
        })
      }
      downloads += 1
      return new Response(Uint8Array.from(bytes))
    })
    const ctx = new Context()
    try {
      await ctx.plugin(storage, { path: ":memory:" })
      await ctx.plugin(settings, {})
      await ctx.plugin(projects)
      await ctx.plugin(threads)
      await ctx.plugin(sessions)
      await ctx.plugin(agents, { fake: false, dataDir: join(root, "agent-data") })
      ctx.agents.register(driver)
      ctx.agents.updateSettings("antigravity", {
        environment: [{ name: "PATH", value: [root, process.env.PATH].join(delimiter) }],
      })
      const work = ctx.agents.createInstance("antigravity", "Work")
      await Promise.all([
        ctx.agents.updateCli("antigravity"),
        ctx.agents.updateCli(work.instanceId),
      ])
      await expect
        .poll(() => ctx.agents.cliUpdates())
        .toMatchObject({
          antigravity: { phase: "succeeded", currentVersion: "1.5.13" },
          [work.instanceId]: { phase: "succeeded", currentVersion: "1.5.13" },
        })
      expect(downloads).toBe(1)

      // 新 Host 重读 Google 发布的版本，旧安装来自同一用户目录。
      ctx.agents.unregister("antigravity")
      corrupt = true
      const nextDriver = new AntigravityDriver(async (input) => {
        if (!String(input).endsWith(".json")) return new Response(Uint8Array.from(bytes))
        const platform = process.platform
        const arch = process.arch === "arm64" ? "arm" : "x64"
        const os = platform === "darwin" ? "mac" : "linux"
        return Response.json({
          version: "1.5.14",
          sha512: "a".repeat(128),
          url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-1/${platform}-${arch}/cli_${os}_${process.arch}.tar.gz`,
        })
      })
      ctx.agents.register(nextDriver)
      try {
        await ctx.agents.updateCli("antigravity")
        await expect
          .poll(() => ctx.agents.cliUpdates().antigravity)
          .toMatchObject({
            phase: "failed",
            currentVersion: "1.5.13",
            error: expect.stringContaining("checksum"),
          })
        await expect(
          ctx.agents.detect({ agentId: "antigravity", refresh: true }),
        ).resolves.toMatchObject({
          antigravity: { installed: true, version: "1.5.13" },
        })
      } finally {
        await nextDriver.close()
      }
    } finally {
      await driver.close()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
  20_000,
)
