import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MOBILE_WORKBENCH_WRITE_CHUNK_BYTES,
  MOBILE_WORKBENCH_WRITE_INLINE_MAX,
  MOBILE_WORKBENCH_WRITE_MAX_BYTES,
  mobileFeatures,
  mobileWorkbenchMethods,
  mobileWorkbenchWriteMethods,
  type MobileWorkspaceReadFileResult,
  type MobileWorkspaceWriteFileResult,
  type MobileWorkspaceWriteStartResult,
} from "@pigcode/contracts"
import { describe, expect, it } from "vitest"
import { revokeDeviceWork } from "./revocation"
import { MobileWorkbenchWrite } from "./workbench-write"
import { setupWorkbenchWriteHost, sha256Hex } from "./workbench-write-test-helper"

describe("mobile workbench.write protocol & Host implementation", { timeout: 30_000 }, () => {
  it("saves small files inline, detects mtime conflict, rejects >32 KiB inline, and chunks large files with SHA-256 & cleanup", async () => {
    expect(mobileFeatures).toContain("workbench.write")
    const root = await mkdtemp(join(tmpdir(), "pigcode-wbw-files-"))
    const host = await setupWorkbenchWriteHost()
    try {
      await writeFile(join(root, "notes.txt"), "one\r\ntwo\r\n", "utf8")
      await writeFile(join(root, "big.ts"), "// initial\n", "utf8")

      const project = host.ctx.projects.add(root, "文件写入项目")
      const thread = host.ctx.threads.create(project.id, "写文件会话", "fake")
      const phone = host.connectDevice("写文件手机", 21, ["workbench.read", "workbench.write"])

      // 1. readFile returns mtimeMs; inline save preserves CRLF
      const readRes = await phone.call(mobileWorkbenchMethods.readFile, {
        threadId: thread.id,
        path: "notes.txt",
        mode: "text",
      })
      const initial = readRes.result as MobileWorkspaceReadFileResult
      expect(initial.mtimeMs).toBeGreaterThan(0)
      expect(initial.eol).toBe("crlf")

      const savedRes = await phone.call(mobileWorkbenchWriteMethods.writeFile, {
        threadId: thread.id,
        path: "notes.txt",
        text: "one\nthree\n",
        expectedMtimeMs: initial.mtimeMs,
        eol: initial.eol,
      })
      expect(savedRes.error).toBeUndefined()
      const saved = savedRes.result as MobileWorkspaceWriteFileResult
      expect(saved.path).toBe("notes.txt")
      expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("one\r\nthree\r\n")

      // 2. External modification triggers WORKBENCH_FILE_CONFLICT
      await new Promise((r) => setTimeout(r, 20))
      await writeFile(join(root, "notes.txt"), "external change\n", "utf8")
      const conflict = await phone.call(mobileWorkbenchWriteMethods.writeFile, {
        threadId: thread.id,
        path: "notes.txt",
        text: "stale edit\n",
        expectedMtimeMs: saved.mtimeMs,
      })
      expect(conflict.error?.code).toBe("WORKBENCH_FILE_CONFLICT")

      // 3. Inline > 32 KiB rejected with WORKBENCH_FILE_TOO_LARGE
      const tooBigInline = "a".repeat(MOBILE_WORKBENCH_WRITE_INLINE_MAX + 1)
      expect(
        await phone.call(mobileWorkbenchWriteMethods.writeFile, {
          threadId: thread.id,
          path: "big.ts",
          text: tooBigInline,
        }),
      ).toMatchObject({ error: { code: "WORKBENCH_FILE_TOO_LARGE" } })

      // 4. Chunked write > 32 KiB with CJK + emoji succeeds with exact SHA-256 verification
      const largeText = "你好世界 🚀 const token = 'pigcode-write';\n".repeat(1400)
      const largeBuf = Buffer.from(largeText, "utf8")
      expect(largeBuf.length).toBeGreaterThan(MOBILE_WORKBENCH_WRITE_INLINE_MAX)
      expect(largeBuf.length).toBeLessThan(MOBILE_WORKBENCH_WRITE_MAX_BYTES)

      const startRes = await phone.call(mobileWorkbenchWriteMethods.writeStart, {
        threadId: thread.id,
        path: "big.ts",
        totalBytes: largeBuf.length,
        sha256: sha256Hex(largeBuf),
        eol: "lf",
      })
      expect(startRes.error).toBeUndefined()
      const start = startRes.result as MobileWorkspaceWriteStartResult
      expect(start.chunkBytes).toBe(MOBILE_WORKBENCH_WRITE_CHUNK_BYTES)

      // Out-of-order offset rejected
      expect(
        await phone.call(mobileWorkbenchWriteMethods.writeChunk, {
          sessionId: start.sessionId,
          offset: 100,
          dataBase64: Buffer.from("abc").toString("base64"),
        }),
      ).toMatchObject({ error: { code: "INVALID_PARAMS" } })

      // Send chunks sequentially
      for (let offset = 0; offset < largeBuf.length; offset += start.chunkBytes) {
        const slice = largeBuf.subarray(
          offset,
          Math.min(offset + start.chunkBytes, largeBuf.length),
        )
        const chunkRes = await phone.call(mobileWorkbenchWriteMethods.writeChunk, {
          sessionId: start.sessionId,
          offset,
          dataBase64: slice.toString("base64"),
        })
        expect(chunkRes.result).toEqual({ receivedBytes: offset + slice.length })
      }
      const commitRes = await phone.call(mobileWorkbenchWriteMethods.writeCommit, {
        sessionId: start.sessionId,
      })
      expect(commitRes.error).toBeUndefined()
      expect(await readFile(join(root, "big.ts"), "utf8")).toBe(largeText)

      // 5. SHA-256 mismatch fails with WORKBENCH_HASH_MISMATCH and cleans session
      const badStart = (
        await phone.call(mobileWorkbenchWriteMethods.writeStart, {
          threadId: thread.id,
          path: "big.ts",
          totalBytes: 5,
          sha256: "0".repeat(64),
        })
      ).result as MobileWorkspaceWriteStartResult
      await phone.call(mobileWorkbenchWriteMethods.writeChunk, {
        sessionId: badStart.sessionId,
        offset: 0,
        dataBase64: Buffer.from("hello").toString("base64"),
      })
      expect(
        await phone.call(mobileWorkbenchWriteMethods.writeCommit, {
          sessionId: badStart.sessionId,
        }),
      ).toMatchObject({ error: { code: "WORKBENCH_HASH_MISMATCH" } })
      expect(
        await phone.call(mobileWorkbenchWriteMethods.writeCommit, {
          sessionId: badStart.sessionId,
        }),
      ).toMatchObject({ error: { code: "WORKBENCH_WRITE_SESSION_NOT_FOUND" } })

      // 6. Oversized totalBytes (> 1 MiB) rejected with WORKBENCH_FILE_TOO_LARGE
      expect(
        await phone.call(mobileWorkbenchWriteMethods.writeStart, {
          threadId: thread.id,
          path: "big.ts",
          totalBytes: MOBILE_WORKBENCH_WRITE_MAX_BYTES + 1,
          sha256: "a".repeat(64),
        }),
      ).toMatchObject({ error: { code: "WORKBENCH_FILE_TOO_LARGE" } })

      // 7. Disconnect cleanup releases in-flight sessions immediately
      const phone2 = host.connectDevice("断连测试手机", 22, ["workbench.write"])
      const orphan = (
        await phone2.call(mobileWorkbenchWriteMethods.writeStart, {
          threadId: thread.id,
          path: "big.ts",
          totalBytes: 10,
          sha256: sha256Hex("0123456789"),
        })
      ).result as MobileWorkspaceWriteStartResult
      phone2.stop()
      const phone2Reconnected = host.connectDevice("断连测试手机", 22, ["workbench.write"])
      expect(
        await phone2Reconnected.call(mobileWorkbenchWriteMethods.writeChunk, {
          sessionId: orphan.sessionId,
          offset: 0,
          dataBase64: Buffer.from("0123456789").toString("base64"),
        }),
      ).toMatchObject({ error: { code: "WORKBENCH_WRITE_SESSION_NOT_FOUND" } })

      // 8. Device revocation cleans up sessions too
      const phone3 = host.connectDevice("撤销手机", 23, ["workbench.write"])
      const revSession = (
        await phone3.call(mobileWorkbenchWriteMethods.writeStart, {
          threadId: thread.id,
          path: "big.ts",
          totalBytes: 4,
          sha256: sha256Hex("test"),
        })
      ).result as MobileWorkspaceWriteStartResult
      revokeDeviceWork(host.ctx, phone3.deviceKey)
      expect(
        await phone3.call(mobileWorkbenchWriteMethods.writeCommit, {
          sessionId: revSession.sessionId,
        }),
      ).toMatchObject({ error: { code: "WORKBENCH_WRITE_SESSION_NOT_FOUND" } })

      // 9. Concurrent double writeCommit: session is atomically removed before any await so only one commits
      const raceText = "race-commit-payload\n"
      const raceStart = (
        await phone.call(mobileWorkbenchWriteMethods.writeStart, {
          threadId: thread.id,
          path: "big.ts",
          totalBytes: Buffer.byteLength(raceText, "utf8"),
          sha256: sha256Hex(raceText),
        })
      ).result as MobileWorkspaceWriteStartResult
      await phone.call(mobileWorkbenchWriteMethods.writeChunk, {
        sessionId: raceStart.sessionId,
        offset: 0,
        dataBase64: Buffer.from(raceText, "utf8").toString("base64"),
      })
      const [commitA, commitB] = await Promise.all([
        phone.call(mobileWorkbenchWriteMethods.writeCommit, { sessionId: raceStart.sessionId }),
        phone.call(mobileWorkbenchWriteMethods.writeCommit, { sessionId: raceStart.sessionId }),
      ])
      const successes = [commitA, commitB].filter((res) => res.error === undefined)
      const failures = [commitA, commitB].filter((res) => res.error !== undefined)
      expect(successes).toHaveLength(1)
      expect(failures).toHaveLength(1)
      expect(failures[0]!.error?.code).toBe("WORKBENCH_WRITE_SESSION_NOT_FOUND")
      expect(await readFile(join(root, "big.ts"), "utf8")).toBe(raceText)

      // 10. Idle TTL expires session cleanly
      const shortTtlWriter = new MobileWorkbenchWrite(host.ctx, phone.deviceKey, () => {}, {
        sessionIdleTtlMs: 30,
      })
      const ttlStart = shortTtlWriter.dispatch({
        jsonrpc: "2.0",
        id: "ttl-1",
        method: mobileWorkbenchWriteMethods.writeStart,
        params: {
          threadId: thread.id,
          path: "big.ts",
          totalBytes: 4,
          sha256: sha256Hex("test"),
        },
      }) as MobileWorkspaceWriteStartResult
      await new Promise((r) => setTimeout(r, 60))
      expect(() =>
        shortTtlWriter.dispatch({
          jsonrpc: "2.0",
          id: "ttl-2",
          method: mobileWorkbenchWriteMethods.writeChunk,
          params: {
            sessionId: ttlStart.sessionId,
            offset: 0,
            dataBase64: Buffer.from("test").toString("base64"),
          },
        }),
      ).toThrow(/过期/)
      shortTtlWriter.close()
    } finally {
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("handles createFile, renamePath, deletePath, non-empty dir guard, symlink escape, .git protection, and legacy client denial", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-wbw-fs-"))
    const outside = await mkdtemp(join(tmpdir(), "pigcode-wbw-out-"))
    const host = await setupWorkbenchWriteHost()
    try {
      await mkdir(join(root, ".git"))
      await writeFile(join(root, ".git", "config"), "[core]\n")
      await writeFile(join(outside, "secret.txt"), "top-secret")
      await symlink(outside, join(root, "escape-dir"))
      await symlink(join(outside, "secret.txt"), join(root, "escape-file.txt"))
      await symlink(join(outside, "missing-target.txt"), join(root, "dangling.txt"))

      const project = host.ctx.projects.add(root, "文件管理项目")
      const thread = host.ctx.threads.create(project.id, "文件管理会话", "fake")
      const phone = host.connectDevice("管理手机", 24, ["workbench.write"])
      const legacy = host.connectDevice("旧版手机", 25, ["workbench.read"])

      // Legacy client without workbench.write receives METHOD_NOT_AVAILABLE for all 20 methods
      for (const method of Object.values(mobileWorkbenchWriteMethods)) {
        expect(await legacy.call(method, { threadId: thread.id })).toMatchObject({
          error: { code: "METHOD_NOT_AVAILABLE" },
        })
      }

      // Create nested file
      const created = await phone.call(mobileWorkbenchWriteMethods.createFile, {
        threadId: thread.id,
        path: "src/sub/new.ts",
        text: "export const n = 1\n",
      })
      expect(created.error).toBeUndefined()
      expect(created.result).toMatchObject({ path: "src/sub/new.ts", size: 19 })

      // Duplicate & dangling symlink target -> WORKBENCH_PATH_EXISTS
      expect(
        await phone.call(mobileWorkbenchWriteMethods.createFile, {
          threadId: thread.id,
          path: "src/sub/new.ts",
        }),
      ).toMatchObject({ error: { code: "WORKBENCH_PATH_EXISTS" } })
      expect(
        await phone.call(mobileWorkbenchWriteMethods.createFile, {
          threadId: thread.id,
          path: "dangling.txt",
        }),
      ).toMatchObject({ error: { code: "WORKBENCH_PATH_EXISTS" } })

      // Rename file
      expect(
        (
          await phone.call(mobileWorkbenchWriteMethods.renamePath, {
            threadId: thread.id,
            oldPath: "src/sub/new.ts",
            newPath: "src/moved/item.ts",
          })
        ).result,
      ).toEqual({ oldPath: "src/sub/new.ts", newPath: "src/moved/item.ts" })

      // Non-empty directory delete blocked without recursive
      expect(
        await phone.call(mobileWorkbenchWriteMethods.deletePath, {
          threadId: thread.id,
          path: "src/moved",
        }),
      ).toMatchObject({ error: { code: "WORKBENCH_DIR_NOT_EMPTY" } })

      // Recursive delete succeeds
      expect(
        (
          await phone.call(mobileWorkbenchWriteMethods.deletePath, {
            threadId: thread.id,
            path: "src",
            recursive: true,
          })
        ).result,
      ).toEqual({ path: "src", deleted: true })

      // Deleting external symlink deletes only symlink, leaving outside target untouched
      expect(
        (
          await phone.call(mobileWorkbenchWriteMethods.deletePath, {
            threadId: thread.id,
            path: "escape-file.txt",
          })
        ).result,
      ).toEqual({ path: "escape-file.txt", deleted: true })
      expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("top-secret")

      // Forbidden paths: .git (case-insensitive), root, .., external symlink parent -> WORKBENCH_PATH_FORBIDDEN
      for (const bad of [
        ".git/config",
        ".GIT",
        ".GIT/config",
        "sub/.GIT",
        ".git/hooks/x",
        ".",
        "../out.txt",
        "escape-dir/pwn.txt",
      ]) {
        const res = await phone.call(mobileWorkbenchWriteMethods.createFile, {
          threadId: thread.id,
          path: bad,
          text: "nope",
        })
        expect(res.error?.code, `createFile ${bad}`).toBe("WORKBENCH_PATH_FORBIDDEN")
        expect(res.error?.message).not.toContain(root)
        expect(res.error?.message).not.toContain(outside)
      }
      expect(
        await phone.call(mobileWorkbenchWriteMethods.renamePath, {
          threadId: thread.id,
          oldPath: "dangling.txt",
          newPath: "sub/.GIT",
        }),
      ).toMatchObject({ error: { code: "WORKBENCH_PATH_FORBIDDEN" } })
      expect(
        await phone.call(mobileWorkbenchWriteMethods.deletePath, {
          threadId: thread.id,
          path: ".git",
          recursive: true,
        }),
      ).toMatchObject({ error: { code: "WORKBENCH_PATH_FORBIDDEN" } })
      expect(
        await phone.call(mobileWorkbenchWriteMethods.deletePath, {
          threadId: thread.id,
          path: ".GIT",
        }),
      ).toMatchObject({ error: { code: "WORKBENCH_PATH_FORBIDDEN" } })
    } finally {
      await host.dispose()
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
