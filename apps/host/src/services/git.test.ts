/** 在临时 git 仓库验证 status、diff、checkpoint capture 与 restore。 */
import { execFile } from "node:child_process"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { WORKTREE, capture, diff, restore, status } from "./git"

const exec = promisify(execFile)
const roots: string[] = []

/** 创建一个带初始提交的临时仓库。 */
async function repo() {
  const root = await mkdtemp(join(tmpdir(), "pigcode-git-"))
  roots.push(root)
  await exec("git", ["init", "-q"], { cwd: root })
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root })
  await exec("git", ["config", "user.name", "Test"], { cwd: root })
  await writeFile(join(root, "a.txt"), "one\n")
  await exec("git", ["add", "."], { cwd: root })
  await exec("git", ["commit", "-qm", "init"], { cwd: root })
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("git service", () => {
  it("captures and restores a checkpoint including untracked files", async () => {
    const root = await repo()
    await writeFile(join(root, "a.txt"), "two\n")
    await writeFile(join(root, "b.txt"), "new\n")
    const checkpoint = await capture(root, "thread-1", "run-1", "final")
    expect(checkpoint.ref).toBe("refs/pigcode/checkpoints/thread-1/run-1/final")
    expect(checkpoint.commitSha).toMatch(/^[0-9a-f]{40}$/)

    await writeFile(join(root, "a.txt"), "three\n")
    await restore(root, checkpoint.commitSha)
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("two\n")
    expect(await readFile(join(root, "b.txt"), "utf8")).toBe("new\n")
  })

  it("captures without staging the user's real index", async () => {
    const root = await repo()
    await writeFile(join(root, "a.txt"), "two\n")
    await writeFile(join(root, "b.txt"), "new\n")

    await capture(root, "thread-1", "run-1", "initial")

    const { stdout } = await exec("git", ["status", "--porcelain=v1"], { cwd: root })
    expect(stdout).toContain(" M a.txt")
    expect(stdout).toContain("?? b.txt")
  })

  it("reports branch and changed paths", async () => {
    const root = await repo()
    const { stdout: branchOutput } = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: root,
    })
    const branch = branchOutput.trim()
    await writeFile(join(root, "a.txt"), "two\n")
    await writeFile(join(root, "b.txt"), "new\n")

    const result = await status(root)
    expect(result.branch).toBe(branch)
    expect(result.changed).toContainEqual({ path: "a.txt", status: " M" })
    expect(result.changed).toContainEqual({ path: "b.txt", status: "??" })
  })

  it("parses rename entries with the new path", async () => {
    const root = await repo()
    await exec("git", ["mv", "a.txt", "c.txt"], { cwd: root })

    const result = await status(root)
    expect(result.changed).toEqual([{ path: "c.txt", status: "R " }])
  })

  it("returns diff text and an empty string when revisions match", async () => {
    const root = await repo()
    const { stdout: head } = await exec("git", ["rev-parse", "HEAD"], { cwd: root })
    await writeFile(join(root, "a.txt"), "two\n")
    const checkpoint = await capture(root, "thread-1", "run-1", "final")

    const patch = await diff(root, head.trim(), checkpoint.commitSha)
    expect(patch).toContain("-one")
    expect(patch).toContain("+two")
    expect(await diff(root, checkpoint.commitSha, checkpoint.commitSha)).toBe("")
  })

  it("diffs the working tree, untracked files included, against a commit", async () => {
    const root = await repo()
    expect(await diff(root, "HEAD", WORKTREE)).toBe("")
    await writeFile(join(root, "a.txt"), "two\n")
    await writeFile(join(root, "b.txt"), "new file\n")

    const patch = await diff(root, "HEAD", WORKTREE)
    expect(patch).toContain("diff --git a/a.txt b/a.txt")
    expect(patch).toContain("+two")
    expect(patch).toContain("new file mode")
    expect(patch).toContain("+new file")
  })

  it("diffs a repository without commits against the empty tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-git-empty-"))
    roots.push(root)
    await exec("git", ["init", "-q"], { cwd: root })
    await writeFile(join(root, "first.txt"), "hello\n")
    expect(await diff(root, "HEAD", WORKTREE)).toContain("+hello")
  })

  it("removes files created after the checkpoint", async () => {
    const root = await repo()
    const checkpoint = await capture(root, "thread-1", "run-1", "final")
    await writeFile(join(root, "extra.txt"), "later\n")

    await restore(root, checkpoint.commitSha)

    await expect(access(join(root, "extra.txt"))).rejects.toThrow()
  })

  it("rejects directories that are not git repositories", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-nogit-"))
    roots.push(root)

    await expect(status(root)).rejects.toThrow("NOT_A_GIT_REPO")
    await expect(capture(root, "thread-1", "run-1", "final")).rejects.toThrow("NOT_A_GIT_REPO")
  })
})
