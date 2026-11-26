import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MOBILE_WORKBENCH_WRITE_INLINE_MAX, type MobilePrStatusResult } from "@pigcode/contracts"
import { describe, expect, it } from "vitest"
import { hasDartClientEnv } from "./dart-env"
import {
  exec,
  initGitRepo,
  MAX_NOISE_ENCRYPTED_FRAME_BYTES,
  setupWorkbenchWriteHost,
  startDartWorkbenchDriver,
} from "./workbench-write-test-helper"

describe.skipIf(!hasDartClientEnv())(
  "mobile workbench.write Dart end-to-end",
  { timeout: 30_000 },
  () => {
    it("runs real Node Host <-> Dart pigcode_client workbench.write end-to-end loopback within single Noise frames", async () => {
      const root = await mkdtemp(join(tmpdir(), "pigcode-wbw-dart-e2e-"))
      const extraRoots: string[] = []
      await initGitRepo(root)
      await writeFile(join(root, "small.txt"), "initial\n", "utf8")
      await writeFile(join(root, "large.dart"), "// placeholder\n", "utf8")
      await exec("git", ["add", "."], { cwd: root })
      await exec("git", ["commit", "-qm", "add files"], { cwd: root })

      let prBranch = "feat/dart-wbw"
      let prState: "OPEN" | "CLOSED" | "MERGED" = "OPEN"
      let prDraft = true
      const makePr = () =>
        JSON.stringify({
          number: 303,
          title: "Dart Write E2E PR",
          state: prState,
          url: "https://github.com/pigcode/pigcode/pull/303",
          headRefName: "feat/dart-wbw",
          baseRefName: "main",
          isDraft: prDraft,
          additions: 55,
          deletions: 3,
          changedFiles: 2,
          reviewDecision: "APPROVED",
          updatedAt: "2026-11-25T19:00:00Z",
          statusCheckRollup: [
            { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
          ],
        })

      const host = await setupWorkbenchWriteHost({
        branchReader: async () => prBranch,
        ghRunner: async (args) => {
          if (args[1] === "create") return makePr()
          if (args[1] === "comment") return ""
          if (args[1] === "ready") {
            prDraft = false
            return ""
          }
          if (args[1] === "close") {
            prState = "CLOSED"
            return ""
          }
          if (args[1] === "reopen") {
            prState = "OPEN"
            return ""
          }
          if (args[1] === "merge") {
            prState = "MERGED"
            if (args.includes("--delete-branch")) prBranch = "main"
            return ""
          }
          if (args[1] === "view") return makePr()
          throw new Error(`unexpected gh args: ${args.join(" ")}`)
        },
      })

      const project = host.ctx.projects.add(root, "Dart 写操作联调项目")
      const thread = host.ctx.threads.create(project.id, "写操作联调会话", "fake")
      const phone = host.connectDevice("Dart 写操作手机", 77, ["workbench.read", "workbench.write"])
      const driver = startDartWorkbenchDriver(phone, "test/workbench_write_e2e_driver.dart")

      try {
        // 1. Read mtimeMs + inline writeFile + stale mtime conflict
        const readSmall = await driver.cmd("readFile", { threadId: thread.id, path: "small.txt" })
        expect(readSmall.ok, readSmall.error).toBe(true)
        const initialMtime = (readSmall.data!.chunk as { mtimeMs: number }).mtimeMs
        expect(initialMtime).toBeGreaterThan(0)

        const writeSmall = await driver.cmd("writeFile", {
          threadId: thread.id,
          path: "small.txt",
          text: "updated via dart\n",
          expectedMtimeMs: initialMtime,
          eol: "lf",
        })
        expect(writeSmall.ok, writeSmall.error).toBe(true)
        expect(await readFile(join(root, "small.txt"), "utf8")).toBe("updated via dart\n")

        await new Promise((r) => setTimeout(r, 20))
        await writeFile(join(root, "small.txt"), "disk edit\n", "utf8")
        const conflictRes = await driver.cmd("writeFile", {
          threadId: thread.id,
          path: "small.txt",
          text: "stale\n",
          expectedMtimeMs: (writeSmall.data!.result as { mtimeMs: number }).mtimeMs,
        })
        expect(conflictRes.ok).toBe(false)
        expect(conflictRes.code).toBe("WORKBENCH_FILE_CONFLICT")

        // 2. Large (> 60 KiB) file transparently chunked & SHA-256 verified by Dart client
        const largeContent = "// 中文大文件保存 🚀\nfinal line = 'pigcode-chunk';\n".repeat(1200)
        expect(Buffer.byteLength(largeContent, "utf8")).toBeGreaterThan(60 * 1024)
        const writeLarge = await driver.cmd("writeFile", {
          threadId: thread.id,
          path: "large.dart",
          text: largeContent,
          eol: "lf",
        })
        expect(writeLarge.ok, writeLarge.error).toBe(true)
        expect((writeLarge.data!.progress as unknown[]).length).toBeGreaterThan(1)
        expect(await readFile(join(root, "large.dart"), "utf8")).toBe(largeContent)

        // 2b. <= 32 KiB text with heavy JSON escaping (> 48 KiB JSON, > 65 KiB raw JSON) seamlessly falls back to chunking and stays <= 65,535 bytes!
        const escapedContent = '\u0001"\\\n'.repeat(5500)
        expect(Buffer.byteLength(escapedContent, "utf8")).toBeLessThanOrEqual(
          MOBILE_WORKBENCH_WRITE_INLINE_MAX,
        )
        expect(Buffer.byteLength(JSON.stringify(escapedContent), "utf8")).toBeGreaterThan(48 * 1024)
        const writeEscaped = await driver.cmd("writeFile", {
          threadId: thread.id,
          path: "large.dart",
          text: escapedContent,
          eol: "lf",
        })
        expect(writeEscaped.ok, writeEscaped.error).toBe(true)
        expect(await readFile(join(root, "large.dart"), "utf8")).toBe(escapedContent)

        // 3. createFile -> renamePath -> deletePath (non-empty guard + recursive delete)
        const created = await driver.cmd("createFile", {
          threadId: thread.id,
          path: "drafts/note.md",
          text: "# draft\n",
        })
        expect(created.ok, created.error).toBe(true)

        const renamed = await driver.cmd("renamePath", {
          threadId: thread.id,
          oldPath: "drafts/note.md",
          newPath: "drafts/final.md",
        })
        expect(renamed.ok, renamed.error).toBe(true)
        expect(renamed.data!.result).toEqual({
          oldPath: "drafts/note.md",
          newPath: "drafts/final.md",
        })

        const nonEmptyDelete = await driver.cmd("deletePath", {
          threadId: thread.id,
          path: "drafts",
        })
        expect(nonEmptyDelete.ok).toBe(false)
        expect(nonEmptyDelete.code).toBe("WORKBENCH_DIR_NOT_EMPTY")

        const recursiveDelete = await driver.cmd("deletePath", {
          threadId: thread.id,
          path: "drafts",
          recursive: true,
        })
        expect(recursiveDelete.ok, recursiveDelete.error).toBe(true)

        // 4. Worktree lifecycle via Dart client
        const wtCreated = await driver.cmd("createWorktree", { threadId: thread.id })
        expect(wtCreated.ok, wtCreated.error).toBe(true)
        const wtId = (wtCreated.data!.worktree as { id: string }).id
        const activeWtPath = host.ctx.worktrees.activePath(thread.id)!
        extraRoots.push(activeWtPath)

        const wtListed = await driver.cmd("listWorktrees", { threadId: thread.id })
        expect(wtListed.ok, wtListed.error).toBe(true)
        expect(wtListed.data!.result).toMatchObject({ mainActive: false })

        const wtSwitched = await driver.cmd("switchWorktree", {
          threadId: thread.id,
          worktreeId: wtId,
        })
        expect(wtSwitched.ok, wtSwitched.error).toBe(true)

        // 5. Checkpoint create -> modify -> restore via Dart client
        const cpCreated = await driver.cmd("createCheckpoint", {
          threadId: thread.id,
          label: "dart-cp",
        })
        expect(cpCreated.ok, cpCreated.error).toBe(true)
        const cpId = (cpCreated.data!.checkpoint as { id: string }).id

        await writeFile(join(activeWtPath, "README.md"), "# dirty\n", "utf8")
        const cpRestored = await driver.cmd("restoreCheckpoint", {
          threadId: thread.id,
          checkpointId: cpId,
        })
        expect(cpRestored.ok, cpRestored.error).toBe(true)
        expect(await readFile(join(activeWtPath, "README.md"), "utf8")).toBe("# pigcode\n")

        const wtRemoved = await driver.cmd("removeWorktree", { threadId: thread.id })
        expect(wtRemoved.ok, wtRemoved.error).toBe(true)

        // 6. All PR write actions via Dart client
        const prCreated = await driver.cmd("createPr", {
          threadId: thread.id,
          title: "Dart Write E2E PR",
          body: "E2E",
          draft: true,
        })
        expect(prCreated.ok, prCreated.error).toBe(true)
        expect((prCreated.data!.result as MobilePrStatusResult).pr?.isDraft).toBe(true)

        const prCommented = await driver.cmd("commentPr", {
          threadId: thread.id,
          body: "LGTM from Dart",
        })
        expect(prCommented.ok, prCommented.error).toBe(true)

        const prReadied = await driver.cmd("readyPr", { threadId: thread.id })
        expect((prReadied.data!.result as MobilePrStatusResult).pr?.isDraft).toBe(false)

        const prClosed = await driver.cmd("closePr", { threadId: thread.id })
        expect((prClosed.data!.result as MobilePrStatusResult).pr?.state).toBe("CLOSED")

        const prReopened = await driver.cmd("reopenPr", { threadId: thread.id })
        expect((prReopened.data!.result as MobilePrStatusResult).pr?.state).toBe("OPEN")

        const prMerged = await driver.cmd("mergePr", {
          threadId: thread.id,
          method: "squash",
          deleteBranch: true,
        })
        expect(prMerged.ok, prMerged.error).toBe(true)
        expect((prMerged.data!.result as MobilePrStatusResult).pr?.state).toBe("MERGED")

        // Verify every Noise frame stayed strictly within single-frame 65,535-byte limit!
        const stats = driver.stats()
        expect(stats.maxFrameCount).toBe(1)
        expect(stats.maxOutboundEncryptedBytes).toBeGreaterThan(0)
        expect(stats.maxOutboundEncryptedBytes).toBeLessThanOrEqual(MAX_NOISE_ENCRYPTED_FRAME_BYTES)
        expect(stats.maxInboundEncryptedBytes).toBeGreaterThan(0)
        expect(stats.maxInboundEncryptedBytes).toBeLessThanOrEqual(MAX_NOISE_ENCRYPTED_FRAME_BYTES)
      } finally {
        driver.close()
        await host.dispose()
        await Promise.all(
          [root, ...extraRoots].map((dir) =>
            rm(dir, { recursive: true, force: true, maxRetries: 5 }),
          ),
        )
      }
    }, 30_000)
  },
)
