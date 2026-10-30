/** 验证 worktree 的创建、切换、移除，以及线程 cwd 跟随活动 worktree。 */
import { execFile } from "node:child_process"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { Context } from "cordis"
import { afterEach, describe, expect, it } from "vitest"
import { apply as git } from "./git"
import { apply as projects } from "./projects"
import { apply as sessions } from "./sessions"
import { apply as storage } from "./storage"
import { apply as threads } from "./threads"
import { apply as workspaceService } from "./workspace"
import { apply as worktrees, threadCwd } from "./worktrees"

const exec = promisify(execFile)
const contexts: Context[] = []
const roots: string[] = []

/** 判断路径是否存在；用于确认 git worktree 的磁盘副作用。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** 创建临时工作区，按需初始化带初始提交的 git 仓库。 */
async function workspace(gitRepo = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pigcode-worktrees-"))
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

/** 建立带 worktree 服务的内存 Host 与临时 git 项目。 */
async function setupGitThread(gitRepo = true) {
  const root = await workspace(gitRepo)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(worktrees)
  const project = ctx.projects.add(root)
  const thread = ctx.threads.create(project.id, "Worktrees", "fake")
  return { ctx, thread, root }
}

afterEach(async () => {
  // 先让服务清理 worktree，再删除临时仓库；新建但未删除的目录也需要回收。
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
  )
})

describe("worktrees service", () => {
  it("creates and removes a worktree", async () => {
    const { ctx, thread, root } = await setupGitThread()

    const worktree = await ctx.worktrees.create(thread.id)

    expect(worktree.path).not.toBe(root)
    expect(worktree.branch).toBe(`pigcode/${thread.id.slice(-8)}`)
    expect(await pathExists(worktree.path)).toBe(true)
    expect(await pathExists(join(worktree.path, "a.txt"))).toBe(true)

    await ctx.worktrees.remove(thread.id)

    expect(await pathExists(worktree.path)).toBe(false)
  })

  it("recreates a worktree after the previous one was removed", async () => {
    const { ctx, thread } = await setupGitThread()
    const first = await ctx.worktrees.create(thread.id)
    await ctx.worktrees.remove(thread.id)

    // 移除 worktree 不会删除分支；再次创建应复用分支而不是因 -b 冲突失败。
    const second = await ctx.worktrees.create(thread.id)

    expect(second.path).not.toBe(first.path)
    expect(second.branch).toBe(first.branch)
    expect(await pathExists(second.path)).toBe(true)
    await ctx.worktrees.remove(thread.id)
  })

  it("tracks the active path and resolves the thread cwd", async () => {
    const { ctx, thread, root } = await setupGitThread()
    expect(ctx.worktrees.activePath(thread.id)).toBeNull()
    expect(threadCwd(ctx, thread.id)).toBe(root)

    const worktree = await ctx.worktrees.create(thread.id)

    expect(ctx.worktrees.activePath(thread.id)).toBe(worktree.path)
    expect(threadCwd(ctx, thread.id)).toBe(worktree.path)

    await ctx.worktrees.remove(thread.id)

    expect(ctx.worktrees.activePath(thread.id)).toBeNull()
    expect(threadCwd(ctx, thread.id)).toBe(root)
  })

  it("points files, git status and checkpoints at the active worktree", async () => {
    const { ctx, thread, root } = await setupGitThread()
    await ctx.plugin(workspaceService)
    await ctx.plugin(git)
    const worktree = await ctx.worktrees.create(thread.id)
    await writeFile(join(worktree.path, "only-in-worktree.txt"), "agent output\n")

    // 文件树、git status 与 checkpoint 都要看 agent 实际工作的目录，而不是主 checkout。
    const tree = await ctx.workspace.tree(thread.id)
    expect(tree.map((entry) => entry.path)).toContain("only-in-worktree.txt")
    const status = await ctx.git.status(thread.id)
    expect(status.branch).toBe(worktree.branch)
    expect(status.changed.map((change) => change.path)).toEqual(["only-in-worktree.txt"])
    expect(await pathExists(join(root, "only-in-worktree.txt"))).toBe(false)

    const checkpoint = await ctx.git.capture(thread.id, "run_wt", "baseline")
    await writeFile(join(worktree.path, "a.txt"), "changed\n")
    await ctx.git.restore(thread.id, checkpoint.commitSha)
    expect(await readFile(join(worktree.path, "a.txt"), "utf8")).toBe("one\n")
    await ctx.worktrees.remove(thread.id)
  })

  it("lists the thread's worktrees that still exist with the active one", async () => {
    const { ctx, thread } = await setupGitThread()
    await expect(ctx.worktrees.list(thread.id)).resolves.toEqual({
      worktrees: [],
      activePath: null,
    })
    const first = await ctx.worktrees.create(thread.id)
    await expect(ctx.worktrees.list(thread.id)).resolves.toEqual({
      worktrees: [first],
      activePath: first.path,
    })
    await ctx.worktrees.remove(thread.id)
    // 目录已经删掉的 worktree 不再列出。
    await expect(ctx.worktrees.list(thread.id)).resolves.toEqual({
      worktrees: [],
      activePath: null,
    })
  })

  it("rejects switching to a worktree that was not created", async () => {
    const { ctx, thread, root } = await setupGitThread()

    await expect(ctx.worktrees.switch(thread.id, join(root, "missing"))).rejects.toThrow(
      "worktree not found",
    )
  })

  it("fails to create a worktree outside a git repository", async () => {
    const { ctx, thread } = await setupGitThread(false)

    await expect(ctx.worktrees.create(thread.id)).rejects.toThrow("not a git repository")
  })
})
