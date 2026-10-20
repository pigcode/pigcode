/** 验证文件树、文件读取、路径逃逸保护与搜索输出解析。 */
import { Context } from "cordis"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { apply as projects } from "./projects"
import { apply as storage } from "./storage"
import { apply as threads } from "./threads"
import { apply as workspace, parseSearchOutput } from "./workspace"

const exec = promisify(execFile)
const roots: string[] = []

/** 创建临时项目根目录，并按需初始化 git 仓库。 */
async function createFixture(initGit = false) {
  const root = await mkdtemp(join(tmpdir(), "pigcode-ws-"))
  roots.push(root)
  if (initGit) await exec("git", ["init", "--quiet"], { cwd: root })
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(workspace)
  const project = ctx.projects.add(root)
  const thread = ctx.threads.create(project.id, "M3", "fake")
  return { ctx, root, thread }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("workspace", () => {
  it("lists files and rejects traversal", async () => {
    const { ctx, root, thread } = await createFixture()
    await mkdir(join(root, "src"))
    await writeFile(join(root, "src", "index.ts"), "export const x = 1\n")

    const tree = await ctx.workspace.tree(thread.id)
    expect(tree.some((entry) => entry.path === "src/index.ts")).toBe(true)
    await expect(ctx.workspace.readFile(thread.id, "../secret")).rejects.toThrow("escapes project")
    await ctx.fiber.dispose()
  })

  it("reads text files inside the project and rejects absolute paths", async () => {
    const { ctx, root, thread } = await createFixture()
    await writeFile(join(root, "README.md"), "# pigcode\n")

    const result = await ctx.workspace.readFile(thread.id, "README.md")
    expect(result).toEqual({
      path: "README.md",
      text: "# pigcode\n",
      truncated: false,
      binary: false,
    })
    await expect(ctx.workspace.readFile(thread.id, join(root, "README.md"))).rejects.toThrow(
      "absolute path",
    )
  })

  it("truncates large files and flags binary content", async () => {
    const { ctx, root, thread } = await createFixture()
    await writeFile(join(root, "big.txt"), Buffer.alloc(1024 * 1024 + 10, 0x61))
    await writeFile(join(root, "bin.dat"), Buffer.from([0x61, 0x00, 0x62]))

    const big = await ctx.workspace.readFile(thread.id, "big.txt")
    expect(big.truncated).toBe(true)
    expect(big.text).toHaveLength(1024 * 1024)

    const binary = await ctx.workspace.readFile(thread.id, "bin.dat")
    expect(binary.binary).toBe(true)
    expect(binary.text).toBe("")
  })

  it("rejects symlinks that escape the project root", async () => {
    const { ctx, root, thread } = await createFixture()
    const outside = await mkdtemp(join(tmpdir(), "pigcode-outside-"))
    roots.push(outside)
    await writeFile(join(outside, "secret.txt"), "secret")
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"))

    await expect(ctx.workspace.readFile(thread.id, "link.txt")).rejects.toThrow("escapes project")
  })

  it("lists untracked files through git ls-files", async () => {
    const { ctx, root, thread } = await createFixture(true)
    await mkdir(join(root, "src"))
    await writeFile(join(root, "src", "index.ts"), "export const x = 1\n")

    const tree = await ctx.workspace.tree(thread.id)
    expect(tree).toContainEqual({ path: "src/index.ts", type: "file" })
  })

  it("parses search output and caps the result count", () => {
    const fixture = "src/a.ts:3:const value = 1\nsrc/b.ts:12:export value\n\n"
    expect(parseSearchOutput(fixture)).toEqual([
      { path: "src/a.ts", line: 3, text: "const value = 1" },
      { path: "src/b.ts", line: 12, text: "export value" },
    ])

    const many = Array.from({ length: 205 }, (_, index) => `f.ts:${index + 1}:line`).join("\n")
    expect(parseSearchOutput(many)).toHaveLength(200)
  })
})
