/** 验证 run 边界自动写 checkpoint 行，以及手动创建、恢复与全局事件订阅。 */
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { ThreadEvent } from "@pigcode/contracts"
import { Context } from "cordis"
import { afterEach, describe, expect, it } from "vitest"
import { apply as providers } from "../providers/registry"
import { FAKE_LONG_RUN_TEXT } from "../providers/fake"
import { apply as checkpoints } from "./checkpoints"
import { apply as git } from "./git"
import { apply as projects } from "./projects"
import { apply as sessions } from "./sessions"
import { apply as storage } from "./storage"
import { apply as threads } from "./threads"

const exec = promisify(execFile)
const contexts: Context[] = []
const roots: string[] = []

/** 轮询到条件成立，最多等待 5s；checkpoint 捕获需要串行启动 git 进程。 */
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("condition not met")
}

/** 创建临时工作区，按需初始化 git 仓库。 */
async function workspace(gitRepo = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pigcode-checkpoints-"))
  roots.push(root)
  if (!gitRepo) return root
  await exec("git", ["init", "-q"], { cwd: root })
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root })
  await exec("git", ["config", "user.name", "Test"], { cwd: root })
  await writeFile(join(root, "a.txt"), "one\n")
  await exec("git", ["add", "."], { cwd: root })
  await exec("git", ["commit", "-qm", "init"], { cwd: root })
  return root
}

/** 建立带 git 与 fake provider 的内存 Host。 */
async function setupGitThread(gitRepo = true) {
  const root = await workspace(gitRepo)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(git)
  await ctx.plugin(checkpoints)
  await ctx.plugin(providers)
  const project = ctx.projects.add(root)
  const thread = ctx.threads.create(project.id, "Checkpoints", "fake")
  return { ctx, thread, root }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
  )
})

describe("checkpoints service", () => {
  it("captures baseline and final checkpoints for a run", async () => {
    const { ctx, thread } = await setupGitThread()
    const { runId, done } = await ctx.providers.startRun(thread.id, "hello")
    await done
    await waitFor(() => ctx.checkpoints.list(thread.id).length === 2)

    const checkpoints = ctx.checkpoints.list(thread.id)
    expect(checkpoints.map((item) => item.phase)).toEqual(["baseline", "final"])
    expect(checkpoints.every((item) => item.runId === runId)).toBe(true)
    expect(checkpoints.every((item) => /^[0-9a-f]{40}$/.test(item.commitSha ?? ""))).toBe(true)

    const created = ctx.sessions
      .read(thread.id, 0)
      .filter((event) => event.type === "checkpoint.created")
    expect(created).toHaveLength(2)
    expect(created.map((event) => (event.payload as { phase: string }).phase)).toEqual([
      "baseline",
      "final",
    ])
  })

  it("restores the workspace and emits thread.updated", async () => {
    const { ctx, thread, root } = await setupGitThread()
    const { done } = await ctx.providers.startRun(thread.id, "hello")
    await done
    await waitFor(() => ctx.checkpoints.list(thread.id).length === 2)
    const baseline = ctx.checkpoints.list(thread.id)[0]!
    await writeFile(join(root, "a.txt"), "changed\n")

    const affected = await ctx.checkpoints.restore(thread.id, baseline.id)

    expect(affected).toContain("a.txt")
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one\n")
    const events = ctx.sessions.read(thread.id, 0)
    expect(events.at(-1)?.type).toBe("thread.updated")
    expect(events.at(-1)?.payload).toEqual({ restored: baseline.id })
  })

  it("creates a manual checkpoint with a label", async () => {
    const { ctx, thread, root } = await setupGitThread()
    await writeFile(join(root, "b.txt"), "new\n")

    const checkpoint = await ctx.checkpoints.create(thread.id, "before refactor")

    expect(checkpoint.phase).toBe("manual")
    expect(checkpoint.label).toBe("before refactor")
    expect(checkpoint.runId).toBeNull()
    expect(checkpoint.gitRef).toContain(`/manual-${checkpoint.id}/manual`)
    expect(ctx.checkpoints.list(thread.id)).toEqual([checkpoint])
    const created = ctx.sessions
      .read(thread.id, 0)
      .filter((event) => event.type === "checkpoint.created")
    expect(created[0]?.payload).toEqual({
      checkpointId: checkpoint.id,
      runId: null,
      phase: "manual",
    })
  })

  it("captures a final checkpoint when a run is interrupted", async () => {
    const { ctx, thread } = await setupGitThread()
    const { runId, done } = await ctx.providers.startRun(thread.id, FAKE_LONG_RUN_TEXT)
    await waitFor(() =>
      ctx.sessions.read(thread.id, 0).some((event) => event.type === "run.started"),
    )
    expect(ctx.providers.cancelRun(runId)).toBe(true)
    await done
    await waitFor(() => ctx.checkpoints.list(thread.id).length === 2)

    expect(ctx.checkpoints.list(thread.id).map((item) => item.phase)).toEqual(["baseline", "final"])
  })

  it("skips automatic capture outside git without blocking the run", async () => {
    const { ctx, thread } = await setupGitThread(false)
    const { runId, done } = await ctx.providers.startRun(thread.id, "hello")
    await done
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(ctx.providers.getRunStatus(runId)).toBe("completed")
    expect(ctx.checkpoints.list(thread.id)).toEqual([])
  })

  it("rejects restoring a checkpoint from another thread", async () => {
    const { ctx, thread, root } = await setupGitThread()
    const manual = await ctx.checkpoints.create(thread.id, "first")
    const other = ctx.threads.create(thread.projectId, "Other", "fake")
    await writeFile(join(root, "a.txt"), "changed\n")

    await expect(ctx.checkpoints.restore(other.id, manual.id)).rejects.toThrow(
      "checkpoint not found",
    )
  })

  it("broadcasts events to global subscribers and stops after unsubscribe", async () => {
    const { ctx, thread } = await setupGitThread()
    const seen: ThreadEvent[] = []
    const unsubscribe = ctx.sessions.subscribeAll((event) => seen.push(event))
    await ctx.checkpoints.create(thread.id, "manual")
    unsubscribe()
    await ctx.checkpoints.create(thread.id, "later")

    expect(seen.some((event) => event.type === "checkpoint.created")).toBe(true)
    expect(seen.filter((event) => event.type === "checkpoint.created")).toHaveLength(1)
  })
})
