import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { browseHostDirectories } from "./browse-dirs"

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe("browseHostDirectories", () => {
  it("lists subdirectories from home default and detects git repositories", () => {
    const root = mkdtempSync(join(tmpdir(), "pigcode-browse-"))
    dirs.push(root)
    mkdirSync(join(root, "alpha/.git"), { recursive: true })
    mkdirSync(join(root, "beta/nested"), { recursive: true })
    mkdirSync(join(root, ".hidden"), { recursive: true })
    writeFileSync(join(root, "plain.txt"), "hello", "utf8")

    const result = browseHostDirectories(undefined, root)
    const canonicalRoot = realpathSync(root)
    expect(result.homePath).toBe(canonicalRoot)
    expect(result.path).toBe(canonicalRoot)
    expect(result.parentPath).toBeTruthy()
    expect(result.entries.map((entry) => entry.name)).toEqual(["alpha", "beta", ".hidden"])
    expect(result.entries.find((entry) => entry.name === "alpha")).toMatchObject({
      isGitRepo: true,
      hasChildren: false,
    })
    expect(result.entries.find((entry) => entry.name === "beta")).toMatchObject({
      isGitRepo: false,
      hasChildren: true,
    })
  })

  it("throws when target path is a file instead of a directory", () => {
    const root = mkdtempSync(join(tmpdir(), "pigcode-browse-file-"))
    dirs.push(root)
    const file = join(root, "note.txt")
    writeFileSync(file, "x", "utf8")
    expect(() => browseHostDirectories(file, root)).toThrow(/not a directory/)
  })
})
