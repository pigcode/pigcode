/** 验证内置插件：随 Host 启动加载、可停用不可卸载、不能被同名包覆盖；用户插件可以卸载。 */
import Loader from "@cordisjs/plugin-loader"
import { Context } from "cordis"
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { stringify } from "yaml"
import { apply as agentsPlugin } from "../agents/registry"
import { writeBootGraph } from "../kernel/boot"
import { uninstallPluginAndClearDefault } from "../rpc/agents"
import { MemoryTransport } from "../rpc/memory-transport"
import { RpcServer } from "../rpc/server"
import {
  installLocalPlugin,
  listPlugins,
  readPluginRecords,
  setPluginEnabled,
  uninstallPlugin,
} from "./plugin-manager"
import { apply as pluginsPlugin } from "./plugins"
import { apply as projects } from "./projects"
import { apply as sessions } from "./sessions"
import { apply as settings } from "./settings"
import { apply as storage } from "./storage"
import { apply as threads } from "./threads"

/** 写一个注册 agent 的 Host 插件包；settings 进入 contributes.agent。 */
async function writeAgentPackage(dir: string, name: string, agentId: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name,
      version: "1.2.3",
      type: "module",
      pigcode: {
        apiVersion: 1,
        kind: "agent",
        displayName: agentId.toUpperCase(),
        host: "./index.mjs",
        provides: [`agent:${agentId}`],
        contributes: {
          agent: {
            id: agentId,
            settings: [{ key: "binaryPath", type: "path", label: "Binary path" }],
          },
        },
      },
    }),
  )
  await writeFile(
    join(dir, "index.mjs"),
    [
      'export const inject = ["agents"]',
      "export function apply(ctx) {",
      "  ctx.agents.register({",
      `    id: ${JSON.stringify(agentId)},`,
      `    displayName: ${JSON.stringify(agentId.toUpperCase())},`,
      "    features: {},",
      "    createSession: async () => ({}),",
      "    send: async () => {},",
      "    interrupt: async () => {},",
      "    dispose: async () => {},",
      "  })",
      `  ctx.effect(() => () => ctx.agents.unregister(${JSON.stringify(agentId)}))`,
      "}",
      "",
    ].join("\n"),
  )
  return dir
}

/**
 * 往 profile 的 node_modules 里写一个插件包：package.json 的 pigcode 声明与 Host 入口 + client 入口。
 * body 缺省时 Host 入口是一个空的 apply。
 */
async function writePluginPackage(
  dir: string,
  options: {
    name: string
    provides?: string[]
    apiVersion?: number
    host?: string
    /** Host 入口的文件名，缺省 index.mjs；换掉它才能让 Node 重新 import 改好的入口。 */
    entry?: string
    body?: string
  },
): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: options.name,
      version: "0.0.0",
      type: "module",
      pigcode: {
        apiVersion: options.apiVersion ?? 1,
        kind: "ui",
        host: options.host ?? "./index.mjs",
        client: "./client.mjs",
        provides: options.provides ?? [],
      },
    }),
  )
  await writeFile(
    join(dir, options.entry ?? "index.mjs"),
    options.body ?? "export function apply() {}\n",
  )
  await writeFile(join(dir, "client.mjs"), "export function apply() {}\n")
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pigcode-builtin-"))
  const builtinDir = await writeAgentPackage(
    join(root, "builtin", "alpha"),
    "@pigcode/agent-alpha",
    "alpha",
  )
  const profileDir = join(root, "profile")
  return { root, profileDir, env: { profileDir, builtin: [builtinDir] } }
}

describe("built-in plugins", () => {
  it("lists built-in plugins first and persists only their enabled state", async () => {
    const { root, env } = await fixture()
    await installLocalPlugin(
      env,
      await writeAgentPackage(join(root, "src-beta"), "pigcode-beta", "beta"),
    )
    const plugins = await listPlugins(env)
    expect(plugins.map((plugin) => [plugin.id, plugin.builtin, plugin.displayName])).toEqual([
      ["agent.@pigcode/agent-alpha", true, "ALPHA"],
      ["agent.pigcode-beta", false, "BETA"],
    ])

    await setPluginEnabled(env, "agent.@pigcode/agent-alpha", false)
    expect((await readPluginRecords(env))[0]?.disabled).toBe(true)
    expect(await readFile(join(env.profileDir, "plugins.yml"), "utf8")).toContain("builtin: true")
    await setPluginEnabled(env, "agent.@pigcode/agent-alpha", true)
    expect((await readPluginRecords(env))[0]?.disabled).toBe(false)
  })

  it("refuses to uninstall a built-in plugin or shadow it with the same package", async () => {
    const { root, env } = await fixture()
    await expect(uninstallPlugin(env, "agent.@pigcode/agent-alpha")).rejects.toThrow(
      "PLUGIN_BUILTIN",
    )
    const copy = await writeAgentPackage(join(root, "copy"), "@pigcode/agent-alpha", "alpha")
    await expect(installLocalPlugin(env, copy)).rejects.toThrow("PLUGIN_BUILTIN")
  })

  it("uninstalls a user plugin and removes its files", async () => {
    const { root, env } = await fixture()
    const entry = await installLocalPlugin(
      env,
      await writeAgentPackage(join(root, "src-beta"), "pigcode-beta", "beta"),
    )
    await uninstallPlugin(env, entry.id, async () => {
      throw new Error("pnpm must not run for a copied plugin")
    })
    expect((await listPlugins(env)).map((plugin) => plugin.id)).toEqual([
      "agent.@pigcode/agent-alpha",
    ])
    await expect(stat(join(env.profileDir, "node_modules", "pigcode-beta"))).rejects.toThrow()
  })
})

describe("plugins service", () => {
  async function host() {
    const { root, profileDir, env } = await fixture()
    const ctx = new Context()
    const base = pathToFileURL(root).href
    await ctx.plugin(Loader, { baseUrl: `${base}/` })
    await ctx.plugin(storage, { path: ":memory:" })
    await ctx.plugin(settings)
    await ctx.plugin(projects)
    await ctx.plugin(threads)
    await ctx.plugin(sessions)
    await ctx.plugin(agentsPlugin, { fake: false })
    await ctx.plugin(pluginsPlugin, { profileDir, builtin: [...env.builtin] })
    return { ctx, root, profileDir, env }
  }

  it("loads built-in agents at startup and unloads them when disabled", async () => {
    const { ctx } = await host()
    await ctx.plugins.loadAll()
    expect(ctx.agents.list().map((driver) => driver.id)).toEqual(["alpha"])
    await ctx.plugins.disable("agent.@pigcode/agent-alpha")
    expect(ctx.agents.list()).toEqual([])
    await ctx.plugins.enable("agent.@pigcode/agent-alpha")
    expect(ctx.agents.list().map((driver) => driver.id)).toEqual(["alpha"])
    await ctx.fiber.dispose()
  })

  it("installs, lists and uninstalls agents over RPC with validated settings", async () => {
    const { ctx, root } = await host()
    await ctx.plugins.loadAll()
    const transport = new MemoryTransport()
    new RpcServer(ctx, transport.host).start()
    let id = 0
    const call = async (method: string, params: unknown) => {
      id += 1
      transport.client.send({ jsonrpc: "2.0", id: String(id), method, params })
      return (await transport.client.next()) as { result?: unknown; error?: { message: string } }
    }

    const source = await writeAgentPackage(join(root, "src-beta"), "pigcode-beta", "beta")
    expect((await call("plugin.installLocal", { sourceDir: source })).error).toBeUndefined()
    const listed = (await call("agent.list", {})).result as {
      agents: Array<{
        agentId: string
        builtin: boolean
        registered: boolean
        fields: unknown[]
      }>
    }
    expect(listed.agents.map((agent) => [agent.agentId, agent.builtin, agent.registered])).toEqual([
      ["alpha", true, true],
      ["beta", false, true],
    ])
    expect(listed.agents[1]?.fields).toHaveLength(1)

    const saved = await call("agent.updateSettings", {
      agentId: "beta",
      values: { binaryPath: "/opt/beta", customModels: ["beta-large"] },
    })
    expect(saved.result).toEqual({
      values: { binaryPath: "/opt/beta", customModels: ["beta-large"] },
    })
    const rejected = await call("agent.updateSettings", {
      agentId: "beta",
      values: { launchArgs: "--x" },
    })
    expect(rejected.error?.message).toContain("unknown setting for beta: launchArgs")

    expect(
      (await call("plugin.uninstall", { id: "agent.@pigcode/agent-alpha" })).error?.message,
    ).toContain("PLUGIN_BUILTIN")
    expect((await call("agent.setDefault", { agentId: "beta" })).error).toBeUndefined()
    expect((await call("plugin.uninstall", { id: "agent.pigcode-beta" })).error).toBeUndefined()
    expect(ctx.agents.list().map((driver) => driver.id)).toEqual(["alpha"])
    // 卸载默认 agent 的插件后默认回到自动；它的设置值保留，重新安装还在。
    const after = (await call("agent.list", {})).result as { defaultAgentId: string | null }
    expect(after.defaultAgentId).toBeNull()
    expect(ctx.agents.getSettings("beta")).toEqual({
      binaryPath: "/opt/beta",
      customModels: ["beta-large"],
    })
    await ctx.fiber.dispose()
  })

  it("lists an installed plugin still written with kind provider as failed and uninstalls it", async () => {
    const { ctx, env } = await host()
    // 改名前装好的插件：plugins.yml 的条目已由 legacy-names.ts 改成 agent. id，包本身没改。
    const dir = join(env.profileDir, "node_modules", "pigcode-old")
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "pigcode-old",
        version: "1.0.0",
        pigcode: { apiVersion: 1, kind: "provider", host: "./index.mjs" },
      }),
    )
    await writeFile(join(dir, "index.mjs"), "export function apply() {}\n")
    await writeFile(
      join(env.profileDir, "plugins.yml"),
      "plugins:\n  - id: provider.pigcode-old\n    name: pigcode-old\n",
    )
    await ctx.plugins.loadAll()
    expect(ctx.agents.list().map((driver) => driver.id)).toEqual(["alpha"])

    const transport = new MemoryTransport()
    new RpcServer(ctx, transport.host).start()
    transport.client.send({ jsonrpc: "2.0", id: "1", method: "plugin.list", params: {} })
    const listed = (await transport.client.next()) as {
      result: Array<{ id: string; kind: string; enabled: boolean; error: string | null }>
    }
    expect(listed.result[1]).toEqual(
      expect.objectContaining({
        id: "agent.pigcode-old",
        kind: "agent",
        enabled: true,
        error:
          'invalid plugin manifest: pigcode.kind: kind "provider" was renamed to "agent" (see docs/plugin-authoring.md)',
      }),
    )

    transport.client.send({
      jsonrpc: "2.0",
      id: "2",
      method: "plugin.uninstall",
      params: { id: "agent.pigcode-old" },
    })
    expect(((await transport.client.next()) as { error?: unknown }).error).toBeUndefined()
    expect((await listPlugins(env)).map((plugin) => plugin.id)).toEqual([
      "agent.@pigcode/agent-alpha",
    ])
    await expect(stat(dir)).rejects.toThrow()
    await ctx.fiber.dispose()
  })

  it("keeps the first plugin that provides a service and leaves the later one out", async () => {
    const { ctx, root } = await host()
    // 两个插件声明同一个 provides；a 先装先启用，b 后装。
    const a = await writeAgentPackage(join(root, "src-a"), "pigcode-a", "echo")
    const b = await writeAgentPackage(join(root, "src-b"), "pigcode-b", "echo")
    await ctx.plugins.installLocal(a)
    await ctx.plugins.installLocal(b)
    await ctx.plugins.loadAll()

    // 先加载的 a 照常注册；b 不加载，摘要里标记为冲突。
    expect(
      ctx.agents
        .list()
        .map((agent) => agent.id)
        .sort(),
    ).toEqual(["alpha", "echo"])
    const listed = await ctx.plugins.list()
    expect(listed.find((plugin) => plugin.id === "agent.pigcode-a")?.conflict).toBeNull()
    expect(listed.find((plugin) => plugin.id === "agent.pigcode-b")?.conflict).toBe(
      "PROVIDES_CONFLICT: agent:echo is already provided by agent.pigcode-a",
    )
    expect(listed.find((plugin) => plugin.id === "agent.pigcode-b")?.error).toBe(
      "PROVIDES_CONFLICT: agent:echo is already provided by agent.pigcode-a",
    )

    // 停用 a 后 b 不再冲突，Host 入口接上；这时再启用 a 会被拒绝，b 继续保留。
    await ctx.plugins.disable("agent.pigcode-a")
    expect(ctx.agents.list().map((agent) => agent.id)).toContain("echo")
    await expect(ctx.plugins.enable("agent.pigcode-a")).rejects.toMatchObject({
      code: "PROVIDES_CONFLICT",
    })
    expect(
      (await ctx.plugins.list()).find((plugin) => plugin.id === "agent.pigcode-b")?.conflict,
    ).toBeNull()

    // 停用 b 再启用 a：a 成为唯一的声明者，照常加载。
    await ctx.plugins.disable("agent.pigcode-b")
    await expect(ctx.plugins.enable("agent.pigcode-a")).resolves.toBeUndefined()
    expect(ctx.agents.list().map((agent) => agent.id)).toContain("echo")
    await ctx.fiber.dispose()
  })

  it("resolves a provides conflict already on disk at startup", async () => {
    const { ctx, profileDir } = await host()
    // 两个插件在 plugins.yml 里都是启用状态，启动前就冲突。
    for (const name of ["pigcode-a", "pigcode-b"]) {
      await writePluginPackage(join(profileDir, "node_modules", name), {
        name,
        provides: ["ui:x"],
      })
    }
    await writeFile(
      join(profileDir, "plugins.yml"),
      stringify({
        plugins: [
          { id: "ui.pigcode-a", name: "pigcode-a" },
          { id: "ui.pigcode-b", name: "pigcode-b" },
        ],
      }),
    )

    await expect(ctx.plugins.loadAll()).resolves.toBeUndefined()

    // 先加载的 a 保留；b 标记为冲突，Host 入口与界面代码都不加载。
    const listed = await ctx.plugins.list()
    expect(listed.find((plugin) => plugin.id === "ui.pigcode-a")?.conflict).toBeNull()
    expect(listed.find((plugin) => plugin.id === "ui.pigcode-b")?.conflict).toBe(
      "PROVIDES_CONFLICT: ui:x is already provided by ui.pigcode-a",
    )
    expect((await ctx.plugins.bootGraph()).entries.map((entry) => entry.id)).toEqual([
      "ui.pigcode-a",
    ])
    await ctx.fiber.dispose()
  })

  it("keeps the host running when a host entry fails to import or apply, and leaves its UI code out", async () => {
    const { ctx, profileDir } = await host()
    // breaking：Host 入口 import 就失败；throwing：apply 抛错。两者都带 client 入口。
    await writePluginPackage(join(profileDir, "node_modules", "pigcode-breaking"), {
      name: "pigcode-breaking",
      provides: ["ui:breaking"],
      host: "missing.mjs",
    })
    await writePluginPackage(join(profileDir, "node_modules", "pigcode-throwing"), {
      name: "pigcode-throwing",
      provides: ["ui:throwing"],
      host: "index.mjs",
      body: 'export function apply() { throw new Error("apply blew up") }',
    })
    await writePluginPackage(join(profileDir, "node_modules", "pigcode-healthy"), {
      name: "pigcode-healthy",
      provides: ["ui:healthy"],
      host: "index.mjs",
      body: "export function apply() {}",
    })
    await writeFile(
      join(profileDir, "plugins.yml"),
      stringify({
        plugins: [
          { id: "ui.pigcode-breaking", name: "pigcode-breaking" },
          { id: "ui.pigcode-throwing", name: "pigcode-throwing" },
          { id: "ui.pigcode-healthy", name: "pigcode-healthy" },
        ],
      }),
    )

    // Host 照常启动。
    await expect(ctx.plugins.loadAll()).resolves.toBeUndefined()
    const listed = await ctx.plugins.list()
    expect(listed.find((plugin) => plugin.id === "ui.pigcode-breaking")?.error).toContain(
      "plugin host entry failed to load",
    )
    expect(listed.find((plugin) => plugin.id === "ui.pigcode-throwing")?.error).toContain(
      "plugin host entry failed to apply: apply blew up",
    )
    expect(listed.find((plugin) => plugin.id === "ui.pigcode-healthy")?.error).toBeNull()
    expect(ctx.plugins.hostFailures()).toEqual(
      new Set(["ui.pigcode-breaking", "ui.pigcode-throwing"]),
    )

    // 出错的插件不加载界面代码；其余插件照常，写出的 boot.json 也一样。
    expect((await ctx.plugins.bootGraph()).entries.map((entry) => entry.id)).toEqual([
      "ui.pigcode-healthy",
    ])
    await writeBootGraph(profileDir, ctx.plugins.hostFailures())
    const written = JSON.parse(await readFile(join(profileDir, "boot.json"), "utf8")) as {
      entries: Array<{ id: string }>
    }
    expect(written.entries.map((entry) => entry.id)).toEqual(["ui.pigcode-healthy"])

    // 换好 Host 入口后刷新一次，错误清掉，界面代码也回来。
    // 换文件名是因为 Node 按 URL 缓存模块，同一个路径不会重新 import。
    await writePluginPackage(join(profileDir, "node_modules", "pigcode-throwing"), {
      name: "pigcode-throwing",
      provides: ["ui:throwing"],
      host: "./fixed.mjs",
      entry: "fixed.mjs",
    })
    await ctx.plugins.reload()
    expect(
      (await ctx.plugins.list()).find((plugin) => plugin.id === "ui.pigcode-throwing")?.error,
    ).toBeNull()
    expect((await ctx.plugins.bootGraph()).entries.map((entry) => entry.id)).toContain(
      "ui.pigcode-throwing",
    )
    await ctx.fiber.dispose()
  })

  it("reports the incompatible api version with both versions and loads no UI code", async () => {
    const { ctx, profileDir } = await host()
    await writePluginPackage(join(profileDir, "node_modules", "pigcode-future"), {
      name: "pigcode-future",
      apiVersion: 2,
      provides: ["ui:future"],
    })
    await writeFile(
      join(profileDir, "plugins.yml"),
      stringify({ plugins: [{ id: "ui.pigcode-future", name: "pigcode-future" }] }),
    )
    await ctx.plugins.loadAll()

    const summary = (await ctx.plugins.list()).find((plugin) => plugin.id === "ui.pigcode-future")
    expect(summary?.apiVersion).toBe(2)
    expect(summary?.error).toBe("unsupported plugin apiVersion: 2; this Host supports 1")
    expect((await ctx.plugins.bootGraph()).entries).toEqual([])
    await ctx.fiber.dispose()
  })

  it("keeps the default agent when another plugin is uninstalled or it is only disabled", async () => {
    const { ctx, root } = await host()
    await ctx.plugins.loadAll()
    const source = await writeAgentPackage(join(root, "src-beta"), "pigcode-beta", "beta")
    await ctx.plugins.installLocal(source)
    ctx.agents.setDefaultAgent("alpha")
    await uninstallPluginAndClearDefault(ctx, "agent.pigcode-beta")
    expect(ctx.agents.configuredDefaultAgent()).toBe("alpha")
    await ctx.plugins.disable("agent.@pigcode/agent-alpha")
    expect(ctx.agents.configuredDefaultAgent()).toBe("alpha")
    await ctx.fiber.dispose()
  })
})
