import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  mobileFeatures,
  mobileMentionFrameBytes,
  mobileMentionMethods,
  type MobileSearchPathsResult,
} from "@pigcode/contracts"
import { describe, expect, it, vi } from "vitest"
import { sanitizeRelativePath } from "./mentions"
import { createCommandDriver, setupMentionsHarness } from "./mentions.test-helpers"
import { mobileFrames } from "./mobile-frames"

describe("mobile composer.mentions protocol", () => {
  it("declares composer.mentions feature and rejects legacy clients and revoked devices", async () => {
    expect(mobileFeatures).toContain("composer.mentions")

    const root = await mkdtemp(join(tmpdir(), "pigcode-mobile-mentions-gate-"))
    const legacy = await setupMentionsHarness({
      features: ["sidebar.read", "timeline.read", "composer.controls", "draft.write"],
    })
    const modern = await setupMentionsHarness({
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
    const harness = await setupMentionsHarness({
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
    const harness = await setupMentionsHarness({ features: ["composer.mentions"] })
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
    const harness = await setupMentionsHarness({ features: ["composer.mentions"] })
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
})
