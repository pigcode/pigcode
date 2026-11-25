import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  mobileFeatures,
  mobileMentionFrameBytes,
  mobileMentionMethods,
  type MobileAgentCommandsResult,
  type MobileSearchPathsResult,
} from "@pigcode/contracts"
import { Context } from "cordis"
import { describe, expect, it, vi } from "vitest"
import type { AgentCommandInfo, AgentDriver } from "../agents/driver"
import { FakeAgentDriver } from "../agents/fake"
import { apply as agents } from "../agents/registry"
import { MemoryTransport } from "../rpc/memory-transport"
import { ThreadFeed } from "../rpc/thread-feed"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { apply as workspace } from "../services/workspace"
import { mobileFrames } from "./mobile-frames"
import { projectMobileAgentCommand, sanitizeRelativePath } from "./mentions"
import { PairedDevices } from "./paired-devices"
import { MobileSidebarRpc } from "./sidebar-rpc"

interface SetupOptions {
  features: readonly string[]
  extraDrivers?: AgentDriver[]
  withWorkspace?: boolean
}

async function setupHarness({ features, extraDrivers = [], withWorkspace = true }: SetupOptions) {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(settings, {})
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  if (withWorkspace) await ctx.plugin(workspace)
  await ctx.plugin(agents)
  for (const driver of extraDrivers) ctx.agents.register(driver)

  const feed = new ThreadFeed(ctx)
  const deviceKey = Buffer.alloc(32, 23).toString("base64url")
  const devices = new PairedDevices(ctx.settings)
  devices.save({ publicKey: deviceKey, name: "联想测试手机", platform: "ios", lastConnectedAt: 1000 })

  const wire = new MemoryTransport()
  const replies = new Map<string, (message: unknown) => void>()
  wire.client.onMessage((message) => {
    const record = message as { id?: string }
    if (record.id && replies.has(record.id)) {
      const resolve = replies.get(record.id)!
      replies.delete(record.id)
      resolve(message)
    }
  })

  const mobile = new MobileSidebarRpc(ctx, feed, wire.host, devices, {
    computerKey: Buffer.alloc(32, 1),
    computerName: "测试电脑",
    deviceKey,
    features,
    relayRevision: () => undefined,
  })
  mobile.start()

  async function mobileCall(method: string, params: Record<string, unknown> = {}) {
    const id = randomUUID()
    const reply = new Promise<unknown>((resolve) => replies.set(id, resolve))
    wire.client.send({ jsonrpc: "2.0", id, method, params })
    return (await reply) as { id: string; result?: unknown; error?: { code: string; message: string } }
  }

  return {
    ctx,
    devices,
    deviceKey,
    mobileCall,
    async dispose() {
      mobile.stop()
      ctx.agents.cancelAll()
      await ctx.fiber.dispose()
    },
  }
}

function createCommandDriver(
  id: string,
  listCommands: (cwd: string | null) => Promise<AgentCommandInfo[]>,
): AgentDriver {
  const fixture = new FakeAgentDriver()
  return {
    id,
    displayName: `Driver ${id}`,
    features: fixture.features,
    executionModes: { plan: true },
    detect: () => fixture.detect(),
    listModels: () => fixture.listModels(),
    listCommands: (_settings, cwd) => listCommands(cwd),
    createSession: (input) => fixture.createSession(input),
    send: (session, input, runtime) => fixture.send(session, input, runtime),
    interrupt: () => fixture.interrupt(),
    dispose: () => fixture.dispose(),
  }
}

describe("mobile composer.mentions protocol", () => {
  it("declares composer.mentions capability and rejects legacy clients and revoked devices", async () => {
    expect(mobileFeatures).toContain("composer.mentions")

    const root = await mkdtemp(join(tmpdir(), "pigcode-mobile-mentions-gate-"))
    const legacy = await setupHarness({
      features: ["sidebar.read", "timeline.read", "composer.controls", "draft.write"],
    })
    const modern = await setupHarness({
      features: ["composer.mentions"],
    })
    try {
      await writeFile(join(root, "README.md"), "# test\n")
      const legacyProject = legacy.ctx.projects.add(root, "旧客户端项目")
      const modernProject = modern.ctx.projects.add(root, "新客户端项目")

      // Legacy client without composer.mentions gets METHOD_NOT_AVAILABLE.
      expect(
        await legacy.mobileCall(mobileMentionMethods.searchPaths, {
          projectId: legacyProject.id,
          query: "README",
        }),
      ).toMatchObject({ error: { code: "METHOD_NOT_AVAILABLE" } })
      expect(
        await legacy.mobileCall(mobileMentionMethods.agentCommands, {
          instanceId: "fake",
          projectId: legacyProject.id,
        }),
      ).toMatchObject({ error: { code: "METHOD_NOT_AVAILABLE" } })

      // Negotiated client succeeds before revocation.
      expect(
        await modern.mobileCall(mobileMentionMethods.searchPaths, {
          projectId: modernProject.id,
          query: "README",
        }),
      ).toMatchObject({
        result: {
          entries: [{ path: "README.md", kind: "file" }],
          truncated: false,
        },
      })

      // Revoked device is rejected even with composer.mentions negotiated.
      const saved = modern.devices.find(modern.deviceKey)!
      modern.devices.remove(saved)
      expect(
        await modern.mobileCall(mobileMentionMethods.searchPaths, {
          projectId: modernProject.id,
          query: "README",
        }),
      ).toMatchObject({ error: { code: "DEVICE_REVOKED" } })
      expect(
        await modern.mobileCall(mobileMentionMethods.agentCommands, {
          instanceId: "fake",
          projectId: modernProject.id,
        }),
      ).toMatchObject({ error: { code: "DEVICE_REVOKED" } })
    } finally {
      await legacy.dispose()
      await modern.dispose()
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  it("rejects devices revoked while an async mention request is in flight", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slowDriver = createCommandDriver("slow-cmd", async () => {
      await gate
      return [{ name: "ping", text: "/ping", kind: "builtin" }]
    })
    const harness = await setupHarness({
      features: ["composer.mentions"],
      extraDrivers: [slowDriver],
    })
    try {
      const pending = harness.mobileCall(mobileMentionMethods.agentCommands, {
        instanceId: "slow-cmd",
      })
      const saved = harness.devices.find(harness.deviceKey)!
      harness.devices.remove(saved)
      release()
      expect(await pending).toMatchObject({ error: { code: "DEVICE_REVOKED" } })
    } finally {
      release()
      await harness.dispose()
    }
  })

  it("supports workspace.searchPaths by project or thread, empty query defaults, filtering, refresh, limits, and scope guards", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-mobile-mentions-paths-"))
    const removedRoot = await mkdtemp(join(tmpdir(), "pigcode-mobile-mentions-removed-"))
    const harness = await setupHarness({ features: ["composer.mentions"] })
    try {
      await mkdir(join(root, "src", "components"), { recursive: true })
      await writeFile(join(root, "README.md"), "# readme\n")
      await writeFile(join(root, "src", "app.ts"), "export {}\n")
      await writeFile(join(root, "src", "components", "file-tree.tsx"), "export {}\n")
      await writeFile(join(root, "src", "components", "button.tsx"), "export {}\n")
      await writeFile(join(removedRoot, "secret.txt"), "hidden\n")

      const project = harness.ctx.projects.add(root, "工作区")
      const removedProject = harness.ctx.projects.add(removedRoot, "已移除项目")
      const missingProject = harness.ctx.projects.add(join(root, "does-not-exist"), "不存在目录")
      const thread = harness.ctx.threads.create(project.id, "主会话", "fake")
      const subagent = harness.ctx.threads.create(project.id, "子代理", "fake", thread.id)
      const hiddenThread = harness.ctx.threads.create(removedProject.id, "隐藏会话", "fake")
      harness.ctx.projects.remove(removedProject.id)

      // Empty/omitted query returns default sorted file recommendations with truncation when > limit.
      const defaultRecs = await harness.mobileCall(mobileMentionMethods.searchPaths, {
        projectId: project.id,
        limit: 2,
      })
      expect(defaultRecs.result).toEqual({
        entries: [
          { path: "README.md", kind: "file" },
          { path: "src/app.ts", kind: "file" },
        ],
        truncated: true,
      })

      // Filtered query returns files and directories (`dir`) with best matches first.
      const filtered = await harness.mobileCall(mobileMentionMethods.searchPaths, {
        projectId: project.id,
        query: "components",
      })
      const filteredResult = filtered.result as MobileSearchPathsResult
      expect(filteredResult.truncated).toBe(false)
      expect(filteredResult.entries[0]).toEqual({ path: "src/components", kind: "dir" })
      expect(filteredResult.entries).toContainEqual({
        path: "src/components/file-tree.tsx",
        kind: "file",
      })

      // Thread scope query works identically.
      const byThread = await harness.mobileCall(mobileMentionMethods.searchPaths, {
        threadId: thread.id,
        query: "ftree",
      })
      expect(byThread.result).toEqual({
        entries: [{ path: "src/components/file-tree.tsx", kind: "file" }],
        truncated: false,
      })

      // Refresh invalidates cached file index and sees newly added files right away.
      await writeFile(join(root, "src", "brand-new.ts"), "export const x = 1\n")
      const refreshed = await harness.mobileCall(mobileMentionMethods.searchPaths, {
        projectId: project.id,
        query: "brand-new",
        refresh: true,
      })
      expect(refreshed.result).toEqual({
        entries: [{ path: "src/brand-new.ts", kind: "file" }],
        truncated: false,
      })

      // Reject missing/conflicting scopes and invalid bounds.
      for (const badParams of [
        { query: "app" },
        { projectId: project.id, threadId: thread.id, query: "app" },
        { projectId: project.id, limit: 0 },
        { projectId: project.id, limit: 51 },
        { projectId: project.id, query: "a".repeat(257) },
        { projectId: project.id, extra: true },
      ]) {
        expect(await harness.mobileCall(mobileMentionMethods.searchPaths, badParams)).toMatchObject(
          { error: { code: "INVALID_PARAMS" } },
        )
      }

      // Reject unauthorized / unavailable projects and threads.
      for (const badScope of [
        { projectId: "pr_missing" },
        { projectId: removedProject.id },
        { projectId: missingProject.id },
        { threadId: "th_missing" },
        { threadId: subagent.id },
        { threadId: hiddenThread.id },
      ]) {
        expect(
          await harness.mobileCall(mobileMentionMethods.searchPaths, {
            ...badScope,
            query: "a",
          }),
        ).toMatchObject({ error: { code: "RESOURCE_NOT_AVAILABLE" } })
      }
    } finally {
      await harness.dispose()
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
      await rm(removedRoot, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  it("sanitizes relative paths, drops traversal/absolute/NUL entries, and enforces single-frame byte budget", async () => {
    expect(sanitizeRelativePath("src/app.ts")).toBe("src/app.ts")
    expect(sanitizeRelativePath("./src//app.ts")).toBe("src/app.ts")
    expect(sanitizeRelativePath("src\\components\\Btn.tsx")).toBe("src/components/Btn.tsx")
    expect(sanitizeRelativePath("src/..hidden/file.ts")).toBe("src/..hidden/file.ts")
    for (const unsafe of [
      "",
      ".",
      "./",
      "/etc/passwd",
      "\\Windows\\System32\\cmd.exe",
      "C:/Users/secret.txt",
      "C:\\Users\\secret.txt",
      "D:relative-drive.txt",
      "../escape.ts",
      "src/../../escape.ts",
      "src/..",
      "src/nul\0byte.ts",
    ]) {
      expect(sanitizeRelativePath(unsafe)).toBeNull()
    }

    const root = await mkdtemp(join(tmpdir(), "pigcode-mobile-mentions-budget-"))
    const harness = await setupHarness({ features: ["composer.mentions"] })
    try {
      const project = harness.ctx.projects.add(root, "大仓库安全测试")

      // Intercept workspace.searchPaths to inject malicious paths + oversized payload.
      const longEntries = Array.from({ length: 40 }, (_, index) => ({
        path: `packages/feature-${String(index).padStart(2, "0")}/${"segment-".repeat(220)}file-${index}.ts`,
        kind: "file" as const,
      }))
      const searchSpy = vi.spyOn(harness.ctx.workspace, "searchPaths")
      searchSpy.mockResolvedValueOnce({
        entries: [
          { path: "/etc/passwd", kind: "file" },
          { path: "../outside.ts", kind: "file" },
          { path: "src/../../outside.ts", kind: "file" },
          { path: "C:\\Windows\\win.ini", kind: "file" },
          { path: "bad\0name.ts", kind: "file" },
          { path: "", kind: "file" },
          { path: "./src/safe\\nested.ts", kind: "file" },
          { path: "src/safe", kind: "directory" },
        ],
        truncated: false,
      })

      const sanitized = await harness.mobileCall(mobileMentionMethods.searchPaths, {
        projectId: project.id,
        query: "safe",
      })
      expect(sanitized.result).toEqual({
        entries: [
          { path: "src/safe/nested.ts", kind: "file" },
          { path: "src/safe", kind: "dir" },
        ],
        truncated: false,
      })

      // Oversized payload is truncated within single-frame byte budget.
      searchSpy.mockResolvedValueOnce({
        entries: longEntries,
        truncated: false,
      })
      const budgeted = await harness.mobileCall(mobileMentionMethods.searchPaths, {
        projectId: project.id,
        query: "segment",
        limit: 40,
      })
      const result = budgeted.result as MobileSearchPathsResult
      expect(result.truncated).toBe(true)
      expect(result.entries.length).toBeGreaterThan(0)
      expect(result.entries.length).toBeLessThan(40)
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(mobileMentionFrameBytes)
      expect([...mobileFrames({ jsonrpc: "2.0", id: budgeted.id, result })]).toHaveLength(1)
    } finally {
      await harness.dispose()
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  it("supports agent.commands with / vs $ distinction, refresh, scope checks, instance guards, and byte budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-mobile-mentions-commands-"))
    const removedRoot = await mkdtemp(join(tmpdir(), "pigcode-mobile-mentions-commands-removed-"))
    let revision = 1
    const receivedCwds: Array<string | null> = []
    const customDriver = createCommandDriver("cmd-agent", async (cwd) => {
      receivedCwds.push(cwd)
      return [
        {
          name: "compact",
          text: "/compact",
          description: "Compact conversation history",
          argumentHint: "[focus]",
          kind: "builtin",
        },
        {
          name: "deploy",
          text: "/deploy",
          description: `Custom command rev ${revision}`,
          argumentHint: "<env>",
          kind: "skill",
        },
        {
          name: "project-lint",
          text: "$project-lint",
          displayName: "Project Lint",
          description: "Run repository lint checks",
          shortDescription: "Lint repo",
          path: "/Users/private/repo/.claude/skills/project-lint/SKILL.md",
          scope: "project",
          kind: "skill",
        },
        {
          name: "user-notes",
          text: "$user-notes",
          displayName: "Notes",
          description: "Personal workflow notes",
          path: "/Users/private/.claude/skills/user-notes/SKILL.md",
          scope: "user",
          kind: "skill",
        },
        {
          name: "mattpocock-skills:tdd",
          text: "$mattpocock-skills:tdd",
          displayName: "TDD",
          description: "Long ".repeat(200),
          shortDescription: "Red-green-refactor",
          path: "/Users/private/.claude/plugins/matt/SKILL.md",
          scope: "user",
          pluginId: "mattpocock-skills@fixture",
          kind: "skill",
        },
      ]
    })

    const hugeDriver = createCommandDriver("huge-cmd", async () =>
      Array.from({ length: 150 }, (_, index) => ({
        name: `skill-${index}`,
        text: `$skill-${index}`,
        displayName: `Skill ${index}`,
        description: "D".repeat(450),
        shortDescription: "S".repeat(120),
        scope: "project",
        kind: "skill" as const,
      })),
    )

    const harness = await setupHarness({
      features: ["composer.mentions"],
      extraDrivers: [customDriver, hugeDriver],
    })
    try {
      const project = harness.ctx.projects.add(root, "命令项目")
      const removedProject = harness.ctx.projects.add(removedRoot, "已移除项目")
      const thread = harness.ctx.threads.create(project.id, "命令会话", "cmd-agent")
      const subagent = harness.ctx.threads.create(project.id, "子代理", "cmd-agent", thread.id)
      const hiddenThread = harness.ctx.threads.create(removedProject.id, "隐藏会话", "cmd-agent")
      harness.ctx.projects.remove(removedProject.id)

      const disabledInstance = harness.ctx.agents.createInstance("cmd-agent", "停用实例")
      harness.ctx.agents.updateInstance(disabledInstance.instanceId, { enabled: false })

      // Project scope query returns both `/` commands and `$` skills without leaking host path/pluginId.
      const first = await harness.mobileCall(mobileMentionMethods.agentCommands, {
        instanceId: "cmd-agent",
        projectId: project.id,
      })
      const firstResult = first.result as MobileAgentCommandsResult
      expect(firstResult.truncated).toBe(false)
      expect(receivedCwds).toEqual([project.rootPath])
      expect(firstResult.commands).toEqual([
        {
          name: "compact",
          text: "/compact",
          kind: "command",
          description: "Compact conversation history",
          argumentHint: "[focus]",
          source: "builtin",
        },
        {
          name: "deploy",
          text: "/deploy",
          kind: "command",
          description: "Custom command rev 1",
          argumentHint: "<env>",
          source: "custom",
        },
        {
          name: "project-lint",
          text: "$project-lint",
          kind: "skill",
          displayName: "Project Lint",
          description: "Run repository lint checks",
          shortDescription: "Lint repo",
          source: "project",
        },
        {
          name: "user-notes",
          text: "$user-notes",
          kind: "skill",
          displayName: "Notes",
          description: "Personal workflow notes",
          source: "user",
        },
        {
          name: "mattpocock-skills:tdd",
          text: "$mattpocock-skills:tdd",
          kind: "skill",
          displayName: "TDD",
          description: expect.stringMatching(/…$/),
          shortDescription: "Red-green-refactor",
          source: "plugin",
        },
      ])
      expect(firstResult.commands[4]?.description?.length).toBeLessThanOrEqual(512)
      for (const command of firstResult.commands) {
        expect(command).not.toHaveProperty("path")
        expect(command).not.toHaveProperty("pluginId")
      }

      // Cached without refresh; refresh: true reloads updated catalog.
      revision = 2
      const cached = await harness.mobileCall(mobileMentionMethods.agentCommands, {
        instanceId: "cmd-agent",
        projectId: project.id,
      })
      expect((cached.result as MobileAgentCommandsResult).commands[1]?.description).toBe(
        "Custom command rev 1",
      )
      const refreshed = await harness.mobileCall(mobileMentionMethods.agentCommands, {
        instanceId: "cmd-agent",
        projectId: project.id,
        refresh: true,
      })
      expect((refreshed.result as MobileAgentCommandsResult).commands[1]?.description).toBe(
        "Custom command rev 2",
      )

      // Thread scope and unscoped (user/builtin only -> cwd = null).
      await harness.mobileCall(mobileMentionMethods.agentCommands, {
        instanceId: "cmd-agent",
        threadId: thread.id,
      })
      await harness.mobileCall(mobileMentionMethods.agentCommands, {
        instanceId: "cmd-agent",
      })
      expect(receivedCwds).toEqual([project.rootPath, project.rootPath, null])

      // Reject conflicting scope or bad params.
      expect(
        await harness.mobileCall(mobileMentionMethods.agentCommands, {
          instanceId: "cmd-agent",
          threadId: thread.id,
          projectId: project.id,
        }),
      ).toMatchObject({ error: { code: "INVALID_PARAMS" } })

      // Reject nonexistent / disabled instances.
      for (const badInstanceId of ["no-such-instance", disabledInstance.instanceId]) {
        expect(
          await harness.mobileCall(mobileMentionMethods.agentCommands, {
            instanceId: badInstanceId,
          }),
        ).toMatchObject({ error: { code: "DRAFT_SELECTION_UNAVAILABLE" } })
      }

      // Reject invalid / unauthorized project or thread scope.
      for (const badScope of [
        { projectId: "pr_missing" },
        { projectId: removedProject.id },
        { threadId: "th_missing" },
        { threadId: subagent.id },
        { threadId: hiddenThread.id },
      ]) {
        expect(
          await harness.mobileCall(mobileMentionMethods.agentCommands, {
            instanceId: "cmd-agent",
            ...badScope,
          }),
        ).toMatchObject({ error: { code: "RESOURCE_NOT_AVAILABLE" } })
      }

      // Huge catalog is truncated safely within single-frame byte budget.
      const huge = await harness.mobileCall(mobileMentionMethods.agentCommands, {
        instanceId: "huge-cmd",
      })
      const hugeResult = huge.result as MobileAgentCommandsResult
      expect(hugeResult.truncated).toBe(true)
      expect(hugeResult.commands.length).toBeGreaterThan(0)
      expect(hugeResult.commands.length).toBeLessThan(150)
      expect(Buffer.byteLength(JSON.stringify(hugeResult))).toBeLessThanOrEqual(
        mobileMentionFrameBytes,
      )
      expect([...mobileFrames({ jsonrpc: "2.0", id: huge.id, result: hugeResult })]).toHaveLength(1)

      // Projection helper handles surrogate-pair clipping safely and skips unprefixed entries.
      expect(
        projectMobileAgentCommand({ name: "bad", text: "bad", kind: "builtin" }),
      ).toBeNull()
      const emojiDesc = "🚀".repeat(300)
      const clipped = projectMobileAgentCommand({
        name: "emoji",
        text: "$emoji",
        description: emojiDesc,
        scope: "system",
        kind: "skill",
      })
      expect(clipped?.source).toBe("system")
      expect(clipped?.description?.length).toBeLessThanOrEqual(512)
      expect(clipped?.description?.endsWith("…")).toBe(true)
    } finally {
      await harness.dispose()
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
      await rm(removedRoot, { recursive: true, force: true, maxRetries: 5 })
    }
  })
})
