/**
 * 脚手架：每种插件生成到临时目录，manifest 能被 SDK 解析且用新名字；生成的入口真的按 manifest 注册：
 * Agent 插件注册的 driver 用 features，Capability 插件 ctx.provide 的服务名就是它 provides 里声明的那个。
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

  it("generates a UI plugin with only a client entry", async () => {
    const dir = await generate("ui", "demo")
    expect((await readdir(dir)).sort()).toEqual(["client.ts", "package.json"])
    const manifest = await manifestOf(dir)
    expect(manifest.name).toBe("pigcode-ui-demo")
    expect(manifest.pigcode).toMatchObject({
      kind: "ui",
      client: "./client.ts",
      inject: [],
      provides: [],
    })
    expect(manifest.pigcode.host).toBeUndefined()
  })

  it("rejects an unknown kind", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "pigcode-create-plugin-")), "x")
    expect(() =>
      execFileSync(process.execPath, [SCRIPT, dir, "bundle", "x"], { stdio: "pipe" }),
    ).toThrow()
  })
})
