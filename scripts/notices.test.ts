/** 验证第三方声明：有许可证文件就用原文，没有就照实写声明，什么都没有时停下。 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { noticeEntries, noticeEntry, renderNotices, type InventoryPackage } from "./notices"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 造一个安装后的包目录。 */
function pkg(files: Record<string, string>): InventoryPackage {
  const dir = mkdtempSync(join(tmpdir(), "pigcode-notice-"))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  return { name: "demo", versions: ["1.0.0"], paths: [dir], license: "MIT" }
}

describe("notice entries", () => {
  it("keeps the license text the package ships", () => {
    const entry = noticeEntry(
      pkg({
        "package.json": JSON.stringify({ license: "MIT", author: "Someone" }),
        LICENSE: "Copyright (c) 2020 Someone\n\nPermission is hereby granted…",
      }),
    )
    expect(entry.license).toBe("MIT")
    expect(entry.texts[0]).toContain("Permission is hereby granted")
    expect(entry.author).toBe("Someone")
  })

  it("falls back to the declared license when the package has no license file", () => {
    const entry = noticeEntry(
      pkg({
        "package.json": JSON.stringify({
          license: "MIT",
          author: "Cordis",
          repository: { url: "git+https://github.com/cordiverse/cordis.git" },
        }),
      }),
    )
    expect(entry.texts).toEqual([])
    expect(entry.author).toBe("Cordis")
    expect(entry.repository).toBe("git+https://github.com/cordiverse/cordis.git")
  })

  it("stops when a package has neither a license file nor a usable declaration", () => {
    const unknown = pkg({ "package.json": JSON.stringify({ license: "UNLICENSED" }) })
    expect(() => noticeEntry(unknown)).toThrow(/no license text/)
    const missing = { ...pkg({ "README.md": "hi" }), license: "Unknown" }
    expect(() => noticeEntry(missing)).toThrow(/no license text/)
  })

  it("covers every version and sorts by name", () => {
    const one = { ...pkg({ LICENSE: "A" }), name: "b", versions: ["2.0.0"] }
    const two = { ...pkg({ LICENSE: "B" }), name: "a", versions: ["1.0.0"] }
    const entries = noticeEntries({ MIT: [one, two] })
    expect(entries.map((entry) => entry.name)).toEqual(["a", "b"])
  })
})

describe("notice file", () => {
  it("starts with Pigcode's own license and lists each package once", () => {
    const entries = noticeEntries({
      MIT: [{ ...pkg({ LICENSE: "MIT text" }), name: "demo", versions: ["1.0.0"] }],
    })
    const text = renderNotices({ ownLicense: "Pigcode MIT text", entries })
    expect(text).toContain("Pigcode MIT text")
    expect(text).toContain("demo 1.0.0")
    expect(text).toContain("MIT text")
    expect(text.match(/demo 1\.0\.0/g)).toHaveLength(1)
  })
})
