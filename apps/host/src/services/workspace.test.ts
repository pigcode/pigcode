/** 验证文件树、文件读取、路径逃逸保护与搜索输出解析。 */
import { Context } from "cordis"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
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
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
  )
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

  it("lists a project's files before it has a thread, for @ in the new thread draft", async () => {
    const { ctx, root, thread } = await createFixture()
    await mkdir(join(root, "src"))
    await writeFile(join(root, "src", "index.ts"), "export const x = 1\n")

    const project = ctx.threads.get(thread.id)!.projectId
    const tree = await ctx.workspace.projectTree(project)
    expect(tree).toContainEqual({ path: "src/index.ts", type: "file" })
    await expect(ctx.workspace.projectTree("missing")).rejects.toThrow("project not found")
    await ctx.fiber.dispose()
  })

  it("reads text files inside the project and rejects absolute paths", async () => {
    const { ctx, root, thread } = await createFixture()
    await writeFile(join(root, "README.md"), "# pigcode\n")

    const result = await ctx.workspace.readFile(thread.id, "README.md")
    expect(result).toMatchObject({
      path: "README.md",
      text: "# pigcode\n",
      truncated: false,
      binary: false,
      size: 10,
      eol: "lf",
    })
    expect(result.mtimeMs).toBeGreaterThan(0)
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

  it("lists one directory at a time with directories first and git-ignored entries marked", async () => {
    const { ctx, root, thread } = await createFixture(true)
    await mkdir(join(root, "src", "nested"), { recursive: true })
    await mkdir(join(root, "build"))
    await writeFile(join(root, ".gitignore"), "build/\n*.log\n")
    await writeFile(join(root, "z.log"), "noise")
    await writeFile(join(root, "a10.ts"), "a")
    await writeFile(join(root, "a9.ts"), "a")
    await writeFile(join(root, "src", "index.ts"), "export {}\n")

    const top = await ctx.workspace.list(thread.id)
    expect(top.entries.map((entry) => [entry.name, entry.kind, entry.ignored === true])).toEqual([
      ["build", "directory", true],
      ["src", "directory", false],
      [".gitignore", "file", false],
      ["a9.ts", "file", false],
      ["a10.ts", "file", false],
      ["z.log", "file", true],
    ])
    expect(top.entries.find((entry) => entry.name === "a9.ts")?.size).toBe(1)
    const src = await ctx.workspace.list(thread.id, "src")
    expect(src.entries.map((entry) => entry.path)).toEqual(["src/nested", "src/index.ts"])
    await expect(ctx.workspace.list(thread.id, "../")).rejects.toThrow("escapes project")
    await expect(ctx.workspace.list(thread.id, "a9.ts")).rejects.toThrow("not a directory")
    await ctx.fiber.dispose()
  })

  it("marks dependency folders as ignored outside git", async () => {
    const { ctx, root, thread } = await createFixture()
    await mkdir(join(root, "node_modules"))
    await mkdir(join(root, "lib"))
    const listing = await ctx.workspace.list(thread.id)
    expect(listing.entries.map((entry) => [entry.name, entry.ignored === true])).toEqual([
      ["lib", false],
      ["node_modules", true],
    ])
    await ctx.fiber.dispose()
  })

  it("searches paths fuzzily with file-name matches first", async () => {
    const { ctx, root, thread } = await createFixture(true)
    await mkdir(join(root, "src", "components"), { recursive: true })
    await writeFile(join(root, "src", "components", "file-tree.tsx"), "")
    await writeFile(join(root, "src", "components", "tree-utils.ts"), "")
    await writeFile(join(root, "src", "free-text.md"), "")
    await writeFile(join(root, "README.md"), "")

    const result = await ctx.workspace.searchPaths(thread.id, "ftree")
    expect(result.entries[0]).toEqual({ path: "src/components/file-tree.tsx", kind: "file" })
    const components = await ctx.workspace.searchPaths(thread.id, "components")
    expect(components.entries[0]).toEqual({ path: "src/components", kind: "directory" })
    const words = await ctx.workspace.searchPaths(thread.id, "comp utils")
    expect(words.entries.map((entry) => entry.path)).toEqual(["src/components/tree-utils.ts"])
    expect((await ctx.workspace.searchPaths(thread.id, "zzz")).entries).toEqual([])
    await ctx.fiber.dispose()
  })

  it("previews images as base64", async () => {
    const { ctx, root, thread } = await createFixture()
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")
    await writeFile(join(root, "logo.png"), png)
    const image = await ctx.workspace.readFile(thread.id, "logo.png", "image")
    expect(image.image).toEqual({ mime: "image/png", base64: png.toString("base64") })
    expect(image.binary).toBe(true)
    await ctx.fiber.dispose()
  })

  it("saves edits, keeps CRLF line endings and refuses stale or unsafe writes", async () => {
    const { ctx, root, thread } = await createFixture()
    await writeFile(join(root, "win.txt"), "one\r\ntwo\r\n")
    const read = await ctx.workspace.readFile(thread.id, "win.txt")
    expect(read.eol).toBe("crlf")

    const saved = await ctx.workspace.writeFile(thread.id, "win.txt", "one\nthree\n", {
      expectedMtimeMs: read.mtimeMs,
      eol: read.eol,
    })
    expect(await readFile(join(root, "win.txt"), "utf8")).toBe("one\r\nthree\r\n")
    expect(saved.size).toBe(12)

    // 别处改过文件之后，用旧的修改时间保存会被拒绝。
    await new Promise((resolve) => setTimeout(resolve, 20))
    await writeFile(join(root, "win.txt"), "external\n")
    await expect(
      ctx.workspace.writeFile(thread.id, "win.txt", "mine", { expectedMtimeMs: saved.mtimeMs }),
    ).rejects.toMatchObject({ code: "FILE_CHANGED" })

    await mkdir(join(root, ".git"))
    await writeFile(join(root, ".git", "config"), "[core]\n")
    await expect(ctx.workspace.writeFile(thread.id, ".git/config", "x")).rejects.toThrow(
      "git metadata",
    )
    await expect(ctx.workspace.writeFile(thread.id, "missing.txt", "x")).rejects.toThrow()
    await expect(ctx.workspace.writeFile(thread.id, "../escape.txt", "x")).rejects.toThrow(
      "escapes project",
    )
    await ctx.fiber.dispose()
  })

  it("sees newly saved files in path search right away", async () => {
    const { ctx, root, thread } = await createFixture(true)
    await writeFile(join(root, "keep.ts"), "a")
    expect((await ctx.workspace.searchPaths(thread.id, "keep")).entries).toHaveLength(1)
    await ctx.workspace.writeFile(thread.id, "keep.ts", "b")
    expect((await ctx.workspace.searchPaths(thread.id, "keep")).entries).toHaveLength(1)
    await ctx.fiber.dispose()
  })
})
