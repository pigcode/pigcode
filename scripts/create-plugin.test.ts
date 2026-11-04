/**
 * 脚手架：每种插件生成到临时目录，manifest 能被 SDK 解析且用新名字；生成的入口真的按 manifest 注册：
 * Agent 插件注册的 driver 用 features，Capability 插件 ctx.provide 的服务名就是它 provides 里声明的那个，
 * UI 插件是 React 插件（client.tsx + 构建配置），生成的入口能编译成 Host 加载的 .mjs。
 */
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import {
  pluginManifestSchema,
  readAgentContribution,
  type PluginManifest,
} from "../packages/plugin-sdk/src/manifest.ts"
import { transpileTypeScript } from "../apps/host/src/services/plugin-typescript.ts"

const SCRIPT = fileURLToPath(new URL("./create-plugin.ts", import.meta.url))

/** 运行脚手架，返回生成目录。 */
async function generate(kind: string, name: string): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "pigcode-create-plugin-")), name)
  execFileSync(process.execPath, [SCRIPT, dir, kind, name], { stdio: "pipe" })
  return dir
}

async function manifestOf(dir: string): Promise<PluginManifest> {
  return pluginManifestSchema.parse(JSON.parse(await readFile(join(dir, "package.json"), "utf8")))
}

/** 加载生成的 Host 入口，用一个只记录调用的 ctx 执行 apply。 */
async function applyHostEntry(dir: string) {
  const provided = new Map<string, unknown>()
  const registered: Array<Record<string, unknown>> = []
  const ctx = {
    sessions: { read: () => [] },
    provide: (name: string, value: unknown) => provided.set(name, value),
    effect: () => {},
    agents: {
      register: (driver: Record<string, unknown>) => registered.push(driver),
      unregister: () => {},
    },
  }
  const entry = (await import(pathToFileURL(join(dir, "index.ts")).href)) as {
    inject: string[]
    apply: (ctx: unknown) => void
  }
  entry.apply(ctx)
  return { inject: entry.inject, provided, registered }
}

describe("create-plugin", () => {
  it("generates an Agent plugin with the agent names", async () => {
    const dir = await generate("agent", "demo-echo")
    expect((await readdir(dir)).sort()).toEqual(["index.ts", "package.json"])
    const manifest = await manifestOf(dir)
    expect(manifest.name).toBe("pigcode-agent-demo-echo")
    expect(manifest.pigcode).toMatchObject({
      kind: "agent",
      host: "./index.ts",
      inject: ["agents"],
      provides: ["agent:demo-echo"],
      contributes: { agent: { id: "demo-echo" } },
    })
    expect(readAgentContribution(manifest)?.id).toBe("demo-echo")

    const { inject, registered } = await applyHostEntry(dir)
    expect(inject).toEqual(["agents"])
    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatchObject({ id: "demo-echo", displayName: "Demo Echo" })
    expect(registered[0]).toHaveProperty("features.streaming", true)
  })

  it("generates a Capability plugin that provides the service its manifest declares", async () => {
    const dir = await generate("capability", "session-info")
    const manifest = await manifestOf(dir)
    expect(manifest.name).toBe("pigcode-capability-session-info")
    expect(manifest.pigcode).toMatchObject({
      kind: "capability",
      host: "./index.ts",
      inject: ["sessions"],
      provides: ["sessionInfo"],
    })

    const { inject, provided, registered } = await applyHostEntry(dir)
    expect(inject).toEqual(["sessions"])
    expect(registered).toEqual([])
    expect([...provided.keys()]).toEqual(manifest.pigcode.provides)
    const service = provided.get("sessionInfo") as { count(threadId: string): number }
    expect(service.count("th_1")).toBe(0)
  })

  it("generates a React UI plugin with build config, and its entry compiles like a Host install", async () => {
    const dir = await generate("ui", "demo")
    expect((await readdir(dir)).sort()).toEqual([
      "build.ts",
      "client.tsx",
      "env.d.ts",
      "package.json",
      "tsconfig.json",
    ])
    const manifest = await manifestOf(dir)
    expect(manifest.name).toBe("pigcode-ui-demo")
    expect(manifest.pigcode).toMatchObject({
      kind: "ui",
      displayName: "Demo",
      client: "./client.tsx",
      inject: [],
      provides: [],
    })
    expect(manifest.pigcode.host).toBeUndefined()

    // 构建配置：React 与 ui-primitives 是插件自己的开发依赖，运行时用宿主的那一份（ADR-0002）。
    // scripts 与 devDependencies 不属于 manifest schema，直接读生成的 package.json。
    const raw = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(raw.scripts).toMatchObject({ build: expect.any(String) })
    expect(raw.devDependencies).toMatchObject({
      react: "19.2.3",
      "@types/react": expect.any(String),
      esbuild: expect.any(String),
      typescript: expect.any(String),
    })
    // 两个 @pigcode/* 没有发布到 npm：写进依赖会让仓库外 `pnpm install` 直接失败，运行时由宿主提供。
    expect(
      Object.keys(raw.devDependencies ?? {}).filter((key) => key.startsWith("@pigcode/")),
    ).toEqual([])
    // 类型配置带上插件自带的全局声明，tsc 检查 ui-primitives 的类型时不会缺 window / import.meta。
    const tsconfig = await readFile(join(dir, "tsconfig.json"), "utf8")
    expect(tsconfig).toContain("env.d.ts")

    // 入口用宿主的 React 与 ui-primitives 写，Panel、Surface、设置页都传组件；插件只有这一种界面写法。
    const source = await readFile(join(dir, "client.tsx"), "utf8")
    expect(source).toContain('from "react"')
    expect(source).toContain('from "@pigcode/ui-primitives"')
    expect(source.match(/Component:/g)).toHaveLength(3)
    expect(source).not.toContain("ctx.ui")

    // 构建脚本把宿主的共享模块标为 external：发布打包时也不会带上第二份 React。
    const build = await readFile(join(dir, "build.ts"), "utf8")
    expect(build).toContain('"@pigcode/ui-primitives"')
    expect(build).toContain('"react/jsx-runtime"')
    expect(build).toContain('"react"')

    // 和 Host 安装时的转换一样：自动 JSX runtime，宿主的模块保留裸 import，产物里不再有 JSX。
    const compiled = await transpileTypeScript(source, "client.tsx")
    expect(compiled).toContain('from "react/jsx-runtime"')
    expect(compiled).toContain('from "react"')
    expect(compiled).toContain('from "@pigcode/ui-primitives"')
    expect(compiled).not.toContain("<ListRow")
    expect(compiled).toContain("panels.register")
    expect(compiled).toContain("surfaces.register")
    expect(compiled).toContain("settingsPages.register")
    expect(compiled).toContain("commands.register")
  })

  it("rejects an unknown kind", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "pigcode-create-plugin-")), "x")
    expect(() =>
      execFileSync(process.execPath, [SCRIPT, dir, "bundle", "x"], { stdio: "pipe" }),
    ).toThrow()
  })
})
