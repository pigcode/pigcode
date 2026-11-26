import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MOBILE_WORKBENCH_CHECKPOINT_AFFECTED_LIMIT,
  mobileWorkbenchWriteMethods,
  type MobileCheckpointCreateResult,
  type MobileCheckpointListResult,
  type MobileCheckpointRestoreResult,
  type MobilePrStatusResult,
  type MobileWorktreeCreateResult,
  type MobileWorktreeListResult,
} from "@pigcode/contracts"
import { describe, expect, it, vi } from "vitest"
import { FAKE_LONG_RUN_TEXT, FakeAgentDriver } from "../agents/fake"
import { commandError, initGitRepo, setupWorkbenchWriteHost } from "./workbench-write-test-helper"

describe("mobile workbench.write worktree, checkpoint & PR operations", { timeout: 30_000 }, () => {
  it("manages worktrees & checkpoints and enforces THREAD_BUSY during an active run", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-wbw-git-"))
    const extraRoots: string[] = []
    await initGitRepo(root)

    const host = await setupWorkbenchWriteHost({ agent: new FakeAgentDriver() })
    try {
      const project = host.ctx.projects.add(root, "Git 项目")
      const thread = host.ctx.threads.create(project.id, "Git 会话", "fake")
      const phone = host.connectDevice("Git 手机", 26, ["workbench.write"])

      // 1. Worktree list -> create -> switch -> remove (never leaks absolute path)
      const initialList = (
        await phone.call(mobileWorkbenchWriteMethods.worktreeList, { threadId: thread.id })
      ).result as MobileWorktreeListResult
      expect(initialList).toEqual({ worktrees: [], mainActive: true })

      const wtCreate = (
        await phone.call(mobileWorkbenchWriteMethods.worktreeCreate, { threadId: thread.id })
      ).result as MobileWorktreeCreateResult
      const activePath = host.ctx.worktrees.activePath(thread.id)!
      extraRoots.push(activePath)
      expect(wtCreate.worktree.active).toBe(true)
      expect(wtCreate.worktree.name).not.toContain("/")
      expect(JSON.stringify(wtCreate)).not.toContain(activePath)

      const wtList = (
        await phone.call(mobileWorkbenchWriteMethods.worktreeList, { threadId: thread.id })
      ).result as MobileWorktreeListResult
      expect(wtList.mainActive).toBe(false)
      expect(wtList.worktrees).toHaveLength(1)
      expect(wtList.worktrees[0]!.id).toBe(wtCreate.worktree.id)

      // 2. Checkpoint create -> edit -> restore
      const cpCreated = (
        await phone.call(mobileWorkbenchWriteMethods.checkpointCreate, {
          threadId: thread.id,
          label: "clean state",
        })
      ).result as MobileCheckpointCreateResult
      expect(cpCreated.checkpoint.phase).toBe("manual")
      expect(cpCreated.checkpoint.label).toBe("clean state")
      expect(cpCreated.checkpoint.restorable).toBe(true)

      const cpList = (
        await phone.call(mobileWorkbenchWriteMethods.checkpointList, { threadId: thread.id })
      ).result as MobileCheckpointListResult
      expect(cpList.checkpoints.some((c) => c.id === cpCreated.checkpoint.id)).toBe(true)

      await writeFile(join(activePath, "README.md"), "# modified\n", "utf8")
      const restored = (
        await phone.call(mobileWorkbenchWriteMethods.checkpointRestore, {
          threadId: thread.id,
          checkpointId: cpCreated.checkpoint.id,
        })
      ).result as MobileCheckpointRestoreResult
      expect(restored.checkpointId).toBe(cpCreated.checkpoint.id)
      expect(restored.affectedCount).toBeGreaterThanOrEqual(1)
      expect(restored.affectedPaths.length).toBeLessThanOrEqual(
        MOBILE_WORKBENCH_CHECKPOINT_AFFECTED_LIMIT,
      )
      expect(await readFile(join(activePath, "README.md"), "utf8")).toBe("# pigcode\n")

      // 3. Active run blocks worktreeCreate, worktreeSwitch, worktreeRemove, and checkpointRestore with THREAD_BUSY
      const started = await host.ctx.agents.startRun(thread.id, FAKE_LONG_RUN_TEXT)
      await vi.waitFor(() => {
        expect(host.ctx.agents.listRuns().some((r) => r.threadId === thread.id)).toBe(true)
      })
      expect(
        await phone.call(mobileWorkbenchWriteMethods.worktreeCreate, { threadId: thread.id }),
      ).toMatchObject({ error: { code: "THREAD_BUSY" } })
      expect(
        await phone.call(mobileWorkbenchWriteMethods.worktreeSwitch, {
          threadId: thread.id,
          worktreeId: wtCreate.worktree.id,
        }),
      ).toMatchObject({ error: { code: "THREAD_BUSY" } })
      expect(
        await phone.call(mobileWorkbenchWriteMethods.worktreeRemove, { threadId: thread.id }),
      ).toMatchObject({ error: { code: "THREAD_BUSY" } })
      expect(
        await phone.call(mobileWorkbenchWriteMethods.checkpointRestore, {
          threadId: thread.id,
          checkpointId: cpCreated.checkpoint.id,
        }),
      ).toMatchObject({ error: { code: "THREAD_BUSY" } })

      // Cancel run & wait until idle (including final checkpoint)
      host.ctx.agents.cancelRun(started.runId)
      await vi.waitFor(() => {
        expect(host.ctx.agents.listRuns()).toEqual([])
      })
      await host.ctx.checkpoints.waitForFinal(started.runId)

      // 4. Active subagent run sharing the same worktree also triggers THREAD_BUSY on parent thread
      const subagent = host.ctx.threads.create(project.id, "子代理会话", "fake", thread.id)
      const subRun = await host.ctx.agents.startRun(subagent.id, FAKE_LONG_RUN_TEXT)
      await vi.waitFor(() => {
        expect(host.ctx.agents.listRuns().some((r) => r.threadId === subagent.id)).toBe(true)
      })
      expect(
        await phone.call(mobileWorkbenchWriteMethods.worktreeCreate, { threadId: thread.id }),
      ).toMatchObject({ error: { code: "THREAD_BUSY" } })
      expect(
        await phone.call(mobileWorkbenchWriteMethods.worktreeSwitch, {
          threadId: thread.id,
          worktreeId: wtCreate.worktree.id,
        }),
      ).toMatchObject({ error: { code: "THREAD_BUSY" } })
      expect(
        await phone.call(mobileWorkbenchWriteMethods.worktreeRemove, { threadId: thread.id }),
      ).toMatchObject({ error: { code: "THREAD_BUSY" } })
      expect(
        await phone.call(mobileWorkbenchWriteMethods.checkpointRestore, {
          threadId: thread.id,
          checkpointId: cpCreated.checkpoint.id,
        }),
      ).toMatchObject({ error: { code: "THREAD_BUSY" } })

      host.ctx.agents.cancelRun(subRun.runId)
      await vi.waitFor(() => {
        expect(host.ctx.agents.listRuns()).toEqual([])
      })
      await host.ctx.checkpoints.waitForFinal(subRun.runId)

      // Now switch and remove succeed
      expect(
        (
          await phone.call(mobileWorkbenchWriteMethods.worktreeSwitch, {
            threadId: thread.id,
            worktreeId: wtCreate.worktree.id,
          })
        ).error,
      ).toBeUndefined()
      expect(
        (await phone.call(mobileWorkbenchWriteMethods.worktreeRemove, { threadId: thread.id }))
          .result,
      ).toEqual({ removed: true })
    } finally {
      await host.dispose()
      await Promise.all(
        [root, ...extraRoots].map((dir) =>
          rm(dir, { recursive: true, force: true, maxRetries: 5 }),
        ),
      )
    }
  })

  it("executes all 6 mobile PR write operations including merge with deleteBranch and maps gh failures to PR_ACTION_FAILED", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-wbw-pr-"))
    let branch = "feat/mobile-pr"
    let state: "OPEN" | "CLOSED" | "MERGED" = "OPEN"
    let isDraft = true
    let failNext: Error | null = null
    const ghLog: string[][] = []

    const makeDetailed = () =>
      JSON.stringify({
        number: 154,
        title: "Workbench Write PR",
        state,
        url: "https://github.com/pigcode/pigcode/pull/154",
        headRefName: "feat/mobile-pr",
        baseRefName: "main",
        isDraft,
        additions: 240,
        deletions: 12,
        changedFiles: 6,
        reviewDecision: "APPROVED",
        updatedAt: "2026-11-25T18:00:00Z",
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
      })

    const host = await setupWorkbenchWriteHost({
      branchReader: async () => branch,
      ghRunner: async (args) => {
        ghLog.push(args)
        if (failNext) {
          const err = failNext
          failNext = null
          throw err
        }
        if (args[1] === "create") return makeDetailed()
        if (args[1] === "comment") return ""
        if (args[1] === "ready") {
          isDraft = false
          return ""
        }
        if (args[1] === "close") {
          state = "CLOSED"
          return ""
        }
        if (args[1] === "reopen") {
          state = "OPEN"
          return ""
        }
        if (args[1] === "merge") {
          state = "MERGED"
          if (args.includes("--delete-branch")) branch = "main"
          return ""
        }
        if (args[1] === "view") {
          if (args.at(-1) === "main") {
            throw commandError({ stderr: 'no pull requests found for branch "main"' })
          }
          return makeDetailed()
        }
        throw new Error(`unexpected gh args: ${args.join(" ")}`)
      },
    })

    try {
      const project = host.ctx.projects.add(root, "PR 写项目")
      const thread = host.ctx.threads.create(project.id, "PR 写会话", "fake")
      const phone = host.connectDevice("PR 写手机", 27, ["workbench.write"])

      const created = (
        await phone.call(mobileWorkbenchWriteMethods.prCreate, {
          threadId: thread.id,
          title: "Workbench Write PR",
          body: "Details",
          base: "main",
          draft: true,
        })
      ).result as MobilePrStatusResult
      expect(created.status).toBe("ok")
      expect(created.pr?.isDraft).toBe(true)

      expect(
        (
          await phone.call(mobileWorkbenchWriteMethods.prComment, {
            threadId: thread.id,
            body: "Ship it!",
          })
        ).result,
      ).toEqual({ ok: true })

      const readied = (
        await phone.call(mobileWorkbenchWriteMethods.prReady, { threadId: thread.id })
      ).result as MobilePrStatusResult
      expect(readied.pr?.isDraft).toBe(false)

      const closed = (
        await phone.call(mobileWorkbenchWriteMethods.prClose, { threadId: thread.id })
      ).result as MobilePrStatusResult
      expect(closed.pr?.state).toBe("CLOSED")

      const reopened = (
        await phone.call(mobileWorkbenchWriteMethods.prReopen, { threadId: thread.id })
      ).result as MobilePrStatusResult
      expect(reopened.pr?.state).toBe("OPEN")

      // Merge with deleteBranch: branch switches to main, refresh still succeeds by PR number 154!
      const merged = (
        await phone.call(mobileWorkbenchWriteMethods.prMerge, {
          threadId: thread.id,
          method: "squash",
          deleteBranch: true,
        })
      ).result as MobilePrStatusResult
      expect(merged.status).toBe("ok")
      expect(merged.pr?.state).toBe("MERGED")
      expect(branch).toBe("main")

      // gh errors map cleanly to PR_ACTION_FAILED
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      try {
        for (const err of [
          commandError({ code: "ENOENT" }),
          commandError({ stderr: "To get started with GitHub CLI, please run: gh auth login" }),
          commandError({ stderr: "no git remotes found" }),
          commandError({ stderr: "Pull request is not mergeable" }),
        ]) {
          failNext = err
          expect(
            await phone.call(mobileWorkbenchWriteMethods.prComment, {
              threadId: thread.id,
              body: "retry",
            }),
          ).toMatchObject({ error: { code: "PR_ACTION_FAILED" } })
        }
      } finally {
        errorSpy.mockRestore()
      }
      expect(ghLog.length).toBeGreaterThan(8)
    } finally {
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
