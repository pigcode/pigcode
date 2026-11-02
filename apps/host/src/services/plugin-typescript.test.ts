/** 验证 TypeScript 插件在安装时被转换成可加载的 .mjs，入口改指向转换结果。 */
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
  compileTypeScriptPlugin,
  compiledEntry,
  isTypeScriptEntry,
  rewriteRelativeImports,
} from "./plugin-typescript"
import { installLocalPlugin } from "./plugin-manager"

const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** 写一个带相对导入、enum 与类型标注的 TypeScript Agent 插件。 */
async function writeTypeScriptPlugin(dir: string): Promise<void> {
  await mkdir(join(dir, "lib"), { recursive: true })
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "pigcode-provider-ts",
      version: "0.1.0",
      type: "module",
      main: "./index.ts",
      pigcode: { apiVersion: 1, kind: "agent", host: "./index.ts" },
    }),
  )
  await writeFile(
    join(dir, "index.ts"),
    [
      'import type { PluginHostContext } from "@pigcode/plugin-sdk"',
      'import { greet, Level } from "./lib/greet.ts"',
      'export const inject: string[] = ["agents"]',
      "export function apply(_ctx: PluginHostContext): string {",
      "  return greet(Level.High)",
      "}",
      "",
    ].join("\n"),
  )
  await writeFile(
    join(dir, "lib/greet.ts"),
    [
      "export enum Level { Low = 1, High = 3 }",
      "export function greet(level: Level): string {",
      "  return `level ${level}`",
      "}",
      "",
    ].join("\n"),
  )
  await writeFile(join(dir, "lib/types.d.ts"), "export type Unused = string\n")
}

describe("TypeScript plugin helpers", () => {
  it("recognises TypeScript entries and their compiled paths", () => {
    expect(isTypeScriptEntry("./index.ts")).toBe(true)
    expect(isTypeScriptEntry("./client.mts")).toBe(true)
    expect(isTypeScriptEntry("./types.d.ts")).toBe(false)
    expect(isTypeScriptEntry("./index.mjs")).toBe(false)
    expect(compiledEntry("./client.mts")).toBe("./client.mjs")
    expect(compiledEntry("./index.mjs")).toBe("./index.mjs")
  })

  it("rewrites relative imports of TypeScript files only", () => {
    expect(
      rewriteRelativeImports(
        [
          'import { a } from "./a.ts"',
          "export * from '../b.mts'",
          'const c = await import("./c.ts")',
          'import "./side-effect.ts"',
          'import pkg from "some-package.ts"',
          'import { d } from "./d.js"',
        ].join("\n"),
      ),
    ).toBe(
      [
        'import { a } from "./a.mjs"',
        "export * from '../b.mjs'",
        'const c = await import("./c.mjs")',
        'import "./side-effect.mjs"',
        'import pkg from "some-package.ts"',
        'import { d } from "./d.js"',
      ].join("\n"),
    )
  })
})

describe("compileTypeScriptPlugin", () => {
  it("emits .mjs next to every source and points the entries at them", async () => {
    const dir = await tempDir("pigcode-ts-plugin-")
    await writeTypeScriptPlugin(dir)

    await expect(compileTypeScriptPlugin(dir)).resolves.toBe(true)

    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      main: string
      pigcode: { host: string }
    }
    expect(manifest.main).toBe("./index.mjs")
    expect(manifest.pigcode.host).toBe("./index.mjs")
    expect(existsSync(join(dir, "lib/greet.mjs"))).toBe(true)
    expect(existsSync(join(dir, "lib/types.d.mjs"))).toBe(false)
    const plugin = (await import(pathToFileURL(join(dir, "index.mjs")).href)) as {
      inject: string[]
      apply: (ctx: unknown) => string
    }
    expect(plugin.inject).toEqual(["agents"])
    expect(plugin.apply({})).toBe("level 3")
  })

  it("leaves JavaScript plugins untouched", async () => {
    const dir = await tempDir("pigcode-js-plugin-")
    const manifest = {
      name: "pigcode-provider-js",
      version: "0.1.0",
      pigcode: { apiVersion: 1, kind: "agent", host: "./index.mjs" },
    }
    await writeFile(join(dir, "package.json"), JSON.stringify(manifest))
    await writeFile(join(dir, "index.mjs"), "export function apply() {}\n")

    await expect(compileTypeScriptPlugin(dir)).resolves.toBe(false)
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8"))).toEqual(manifest)
  })

  it("names the file when a source cannot be converted", async () => {
    const dir = await tempDir("pigcode-bad-ts-plugin-")
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "pigcode-ui-bad",
        version: "0.1.0",
        pigcode: { apiVersion: 1, kind: "ui", client: "./client.ts" },
      }),
    )
    await writeFile(join(dir, "client.ts"), "export const broken: = 1\n")

    await expect(compileTypeScriptPlugin(dir)).rejects.toThrow(
      "PLUGIN_TYPESCRIPT_INVALID: client.ts",
    )
  })

  it("compiles the profile copy on local install and keeps the source directory as written", async () => {
    const source = await tempDir("pigcode-ts-source-")
    const profile = await tempDir("pigcode-ts-profile-")
    await writeTypeScriptPlugin(source)

    const entry = await installLocalPlugin(profile, source)

    expect(entry.id).toBe("agent.pigcode-provider-ts")
    const installed = join(profile, "node_modules", "pigcode-provider-ts")
    expect(existsSync(join(installed, "index.mjs"))).toBe(true)
    expect(existsSync(join(source, "index.mjs"))).toBe(false)
    const sourceManifest = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as {
      main: string
    }
    expect(sourceManifest.main).toBe("./index.ts")
  })
})
