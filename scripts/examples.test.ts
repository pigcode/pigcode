/** 示例插件按 ADR 0006 以构建好的包分发：入口都指向 dist 里的 .js，安装时不需要编译器。 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const examplesDir = fileURLToPath(new URL("../examples", import.meta.url))

interface Manifest {
  main?: string
  pigcode?: { host?: string; client?: string }
}

const examples = readdirSync(examplesDir, { withFileTypes: true })
  .filter(
    (entry) => entry.isDirectory() && existsSync(join(examplesDir, entry.name, "package.json")),
  )
  .map((entry) => {
    const dir = join(examplesDir, entry.name)
    return {
      dir,
      manifest: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest,
    }
  })

describe("example plugins", () => {
  it("finds the samples", () => {
    expect(examples.length).toBeGreaterThan(0)
  })

  it.each(examples)("$dir ships built entries", ({ dir, manifest }) => {
    const entries = [manifest.main, manifest.pigcode?.host, manifest.pigcode?.client].filter(
      (entry): entry is string => typeof entry === "string",
    )
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      // 指向源码时，没有编译器的安装包会拒绝安装。
      expect(entry).not.toMatch(/\.m?tsx?$/)
      expect(existsSync(join(dir, entry))).toBe(true)
    }
  })
})
