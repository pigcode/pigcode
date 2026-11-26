import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  mobileFeatures,
  mobileWorkbenchMethods,
  type MobileWorkspaceListResult,
} from "@pigcode/contracts"
import { describe, expect, it } from "vitest"
import { setupWorkbenchReadHost } from "./workbench-test-helper"

describe("mobile workbench.read protocol & Host implementation", () => {
  it("lists directories sorted (dirs first, case-insensitive) with 48 KiB frame-budget pagination", async () => {
    expect(mobileFeatures).toContain("workbench.read")
    const root = await mkdtemp(join(tmpdir(), "pigcode-wb-list-"))
    const host = await setupWorkbenchReadHost()
    try {
      await mkdir(join(root, "Zeta"))
      await mkdir(join(root, "alpha"))
      await mkdir(join(root, "Beta"))
      await writeFile(join(root, "gamma.ts"), "export const g = 1\n")
      await writeFile(join(root, "Alpha.md"), "# alpha\n")
      await writeFile(join(root, "beta.dart"), "void main() {}\n")

      // Create a subdirectory with hundreds of long-named files to trigger 48 KiB byte-budget paging.
      const bigDir = join(root, "many")
      await mkdir(bigDir)
      const totalMany = 360
      const suffix = "x".repeat(160)
      await Promise.all(
        Array.from({ length: totalMany }, (_, i) =>
          writeFile(join(bigDir, `item-${String(i).padStart(4, "0")}-${suffix}.txt`), "ok"),
        ),
      )

      const project = host.ctx.projects.add(root, "排序与分页项目")
      const thread = host.ctx.threads.create(project.id, "工作台会话", "fake")
      const phone = host.connectDevice("主手机", 10, ["workbench.read"])

      const rootRes = await phone.call(mobileWorkbenchMethods.list, { threadId: thread.id })
      expect(rootRes.error).toBeUndefined()
      const rootListing = rootRes.result as MobileWorkspaceListResult
      expect(rootListing.path).toBe("")
      expect(rootListing.truncated).toBe(false)
      expect(rootListing.nextOffset).toBeUndefined()
      expect(rootListing.entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
        "directory:alpha",
        "directory:Beta",
        "directory:many",
        "directory:Zeta",
        "file:Alpha.md",
        "file:beta.dart",
        "file:gamma.ts",
      ])

      // Paginate through `many/` with limit 200; the 48 KiB budget forces multiple pages.
      const collected: string[] = []
      let offset = 0
      let pages = 0
      for (;;) {
        pages += 1
        const pageRes = await phone.call(mobileWorkbenchMethods.list, {
          threadId: thread.id,
          path: "many",
          offset,
          limit: 200,
        })
        expect(pageRes.error).toBeUndefined()
        const page = pageRes.result as MobileWorkspaceListResult
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(48 * 1024)
        for (const entry of page.entries) collected.push(entry.name)
        if (page.nextOffset === undefined) {
          expect(page.truncated).toBe(false)
          break
        }
        expect(page.truncated).toBe(true)
        expect(page.nextOffset).toBeGreaterThan(offset)
        offset = page.nextOffset
      }
      // 360 entries * ~220+ bytes JSON each > 79 KiB, so must require >= 2 pages even with limit 200.
      expect(pages).toBeGreaterThanOrEqual(2)
      expect(collected).toHaveLength(totalMany)
      expect(new Set(collected).size).toBe(totalMany)
    } finally {
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects path traversal, external symlinks, missing files, deleted projects, subagents, revoked devices, and legacy clients without leaking host paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-wb-sec-"))
    const outside = await mkdtemp(join(tmpdir(), "pigcode-wb-outside-"))
    const host = await setupWorkbenchReadHost()
    try {
      const secretFile = join(outside, "host-secret.txt")
      await writeFile(secretFile, "top-secret")
      await writeFile(join(root, "hello.ts"), "export const ok = true\n")
      await symlink(secretFile, join(root, "escape-file.txt"))
      await symlink(outside, join(root, "escape-dir"))

      const project = host.ctx.projects.add(root, "安全项目")
      const removedProject = host.ctx.projects.add(outside, "已删项目")
      const thread = host.ctx.threads.create(project.id, "主会话", "fake")
      const subagent = host.ctx.threads.create(project.id, "子代理", "fake", thread.id)
      const hiddenThread = host.ctx.threads.create(removedProject.id, "已删会话", "fake")
      host.ctx.projects.remove(removedProject.id)

      const phone = host.connectDevice("安全手机", 11, ["workbench.read"])
      const legacy = host.connectDevice("旧版手机", 12, ["sidebar.read", "timeline.read"])

      // Legacy client without workbench.read gets METHOD_NOT_AVAILABLE on all 4 methods.
      for (const [method, params] of [
        [mobileWorkbenchMethods.list, { threadId: thread.id }],
        [mobileWorkbenchMethods.readFile, { threadId: thread.id, path: "hello.ts" }],
        [mobileWorkbenchMethods.search, { threadId: thread.id, query: "ok" }],
        [mobileWorkbenchMethods.prStatus, { threadId: thread.id }],
      ] as const) {
        expect(await legacy.call(method, params)).toMatchObject({
          error: { code: "METHOD_NOT_AVAILABLE" },
        })
      }

      // Path traversal and absolute paths rejected without leaking host paths.
      for (const badPath of [
        "../host-secret.txt",
        "a/../../etc/passwd",
        secretFile,
        "/etc/passwd",
      ]) {
        const listRes = await phone.call(mobileWorkbenchMethods.list, {
          threadId: thread.id,
          path: badPath,
        })
        expect(listRes.error?.code).toBe("INVALID_PARAMS")
        expect(listRes.error?.message).not.toContain(root)
        expect(listRes.error?.message).not.toContain(outside)

        const readRes = await phone.call(mobileWorkbenchMethods.readFile, {
          threadId: thread.id,
          path: badPath,
        })
        expect(readRes.error?.code).toBe("INVALID_PARAMS")
        expect(readRes.error?.message).not.toContain(root)
        expect(readRes.error?.message).not.toContain(outside)
      }

      // Symlinks pointing outside project rejected without leaking host paths.
      const escapedRead = await phone.call(mobileWorkbenchMethods.readFile, {
        threadId: thread.id,
        path: "escape-file.txt",
      })
      expect(escapedRead.error?.code).toBe("INVALID_PARAMS")
      expect(escapedRead.error?.message).not.toContain(outside)

      const escapedList = await phone.call(mobileWorkbenchMethods.list, {
        threadId: thread.id,
        path: "escape-dir",
      })
      expect(escapedList.error?.code).toBe("INVALID_PARAMS")
      expect(escapedList.error?.message).not.toContain(outside)

      // Missing file returns RESOURCE_NOT_AVAILABLE without leaking host path.
      const missing = await phone.call(mobileWorkbenchMethods.readFile, {
        threadId: thread.id,
        path: "does-not-exist.ts",
      })
      expect(missing.error?.code).toBe("RESOURCE_NOT_AVAILABLE")
      expect(missing.error?.message).not.toContain(root)

      // Deleted project thread and subagent thread are rejected.
      for (const blockedThreadId of [hiddenThread.id, subagent.id]) {
        expect(
          await phone.call(mobileWorkbenchMethods.list, { threadId: blockedThreadId }),
        ).toMatchObject({ error: { code: "RESOURCE_NOT_AVAILABLE" } })
      }

      // Revoked device is rejected.
      const saved = host.devices.find(phone.deviceKey)!
      host.devices.remove(saved)
      expect(await phone.call(mobileWorkbenchMethods.list, { threadId: thread.id })).toMatchObject({
        error: { code: "DEVICE_REVOKED" },
      })
    } finally {
      await host.dispose()
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
