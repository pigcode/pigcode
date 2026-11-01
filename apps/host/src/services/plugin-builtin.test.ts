/** 验证内置插件：随 Host 启动加载、可停用不可卸载、不能被同名包覆盖；用户插件可以卸载。 */
import Loader from "@cordisjs/plugin-loader"
import { Context } from "cordis"
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { apply as providers } from "../providers/registry"
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

/**
 * 写一个注册 agent 的 Host 插件包；settings 进入 contributes.provider，
 * names 为 agent 时 manifest 改用新名字（kind、contributes 与 provides 都写 agent）。
 */
async function writeProviderPackage(
  dir: string,
  name: string,
  providerId: string,
  names: "agent" | "provider" = "provider",
): Promise<string> {
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name,
      version: "1.2.3",
      type: "module",
      pigcode: {
        apiVersion: 1,
        kind: names,
        displayName: providerId.toUpperCase(),
        host: "./index.mjs",
        provides: [`${names}:${providerId}`],
        contributes: {
          [names]: {
            id: providerId,
            settings: [{ key: "binaryPath", type: "path", label: "Binary path" }],
          },
        },
      },
    }),
  )
  await writeFile(
    join(dir, "index.mjs"),
    [
      'export const inject = ["providers"]',
      "export function apply(ctx) {",
      "  ctx.providers.register({",
      `    id: ${JSON.stringify(providerId)},`,
      `    displayName: ${JSON.stringify(providerId.toUpperCase())},`,
      "    capabilities: {},",
      "    createSession: async () => ({}),",
      "    send: async () => {},",
      "    interrupt: async () => {},",
      "    dispose: async () => {},",
      "  })",
      `  ctx.effect(() => () => ctx.providers.unregister(${JSON.stringify(providerId)}))`,
      "}",
      "",
    ].join("\n"),
  )
  return dir
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pigcode-builtin-"))
  const builtinDir = await writeProviderPackage(
    join(root, "builtin", "alpha"),
    "@pigcode/provider-alpha",
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
      await writeProviderPackage(join(root, "src-beta"), "pigcode-beta", "beta"),
    )
    const plugins = await listPlugins(env)
    expect(plugins.map((plugin) => [plugin.id, plugin.builtin, plugin.displayName])).toEqual([
      ["provider.@pigcode/provider-alpha", true, "ALPHA"],
      ["provider.pigcode-beta", false, "BETA"],
    ])

    await setPluginEnabled(env, "provider.@pigcode/provider-alpha", false)
    expect((await readPluginRecords(env))[0]?.disabled).toBe(true)
    expect(await readFile(join(env.profileDir, "plugins.yml"), "utf8")).toContain("builtin: true")
    await setPluginEnabled(env, "provider.@pigcode/provider-alpha", true)
    expect((await readPluginRecords(env))[0]?.disabled).toBe(false)
  })

  it("refuses to uninstall a built-in plugin or shadow it with the same package", async () => {
    const { root, env } = await fixture()
    await expect(uninstallPlugin(env, "provider.@pigcode/provider-alpha")).rejects.toThrow(
      "PLUGIN_BUILTIN",
    )
    const copy = await writeProviderPackage(join(root, "copy"), "@pigcode/provider-alpha", "alpha")
    await expect(installLocalPlugin(env, copy)).rejects.toThrow("PLUGIN_BUILTIN")
  })

  it("uninstalls a user plugin and removes its files", async () => {
    const { root, env } = await fixture()
    const entry = await installLocalPlugin(
      env,
      await writeProviderPackage(join(root, "src-beta"), "pigcode-beta", "beta"),
    )
    await uninstallPlugin(env, entry.id, async () => {
      throw new Error("pnpm must not run for a copied plugin")
    })
    expect((await listPlugins(env)).map((plugin) => plugin.id)).toEqual([
      "provider.@pigcode/provider-alpha",
    ])
    await expect(stat(join(env.profileDir, "node_modules", "pigcode-beta"))).rejects.toThrow()
  })

  it("gives an Agent plugin written with the new names the same id, kind and conflicts", async () => {
    const { root, env } = await fixture()
    const source = await writeProviderPackage(
      join(root, "src-gamma"),
      "pigcode-gamma",
      "alpha",
      "agent",
    )
    const entry = await installLocalPlugin(env, source)
    expect(entry.id).toBe("provider.pigcode-gamma")
    const gamma = (await listPlugins(env)).find((plugin) => plugin.id === entry.id)
    expect(gamma).toMatchObject({ kind: "provider", provides: ["provider:alpha"] })
    expect(Object.keys(gamma?.contributes ?? {})).toEqual(["provider"])
    // agent:alpha 和内置插件的 provider:alpha 是同一个声明，算冲突。
    expect(gamma?.conflict).toContain("provider:alpha is provided by")
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
    await ctx.plugin(providers, { fake: false })
    await ctx.plugin(pluginsPlugin, { profileDir, builtin: [...env.builtin] })
    return { ctx, root, env }
  }

  it("loads built-in agents at startup and unloads them when disabled", async () => {
    const { ctx } = await host()
    await ctx.plugins.loadAll()
    expect(ctx.providers.list().map((driver) => driver.id)).toEqual(["alpha"])
    await ctx.plugins.disable("provider.@pigcode/provider-alpha")
    expect(ctx.providers.list()).toEqual([])
    await ctx.plugins.enable("provider.@pigcode/provider-alpha")
    expect(ctx.providers.list().map((driver) => driver.id)).toEqual(["alpha"])
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

    const source = await writeProviderPackage(join(root, "src-beta"), "pigcode-beta", "beta")
    expect((await call("plugin.installLocal", { sourceDir: source })).error).toBeUndefined()
    const listed = (await call("agent.list", {})).result as {
      agents: Array<{
        providerId: string
        builtin: boolean
        registered: boolean
        fields: unknown[]
      }>
    }
    expect(
      listed.agents.map((agent) => [agent.providerId, agent.builtin, agent.registered]),
    ).toEqual([
      ["alpha", true, true],
      ["beta", false, true],
    ])
    expect(listed.agents[1]?.fields).toHaveLength(1)

    const saved = await call("agent.updateSettings", {
      providerId: "beta",
      values: { binaryPath: "/opt/beta", customModels: ["beta-large"] },
    })
    expect(saved.result).toEqual({
      values: { binaryPath: "/opt/beta", customModels: ["beta-large"] },
    })
    const rejected = await call("agent.updateSettings", {
      providerId: "beta",
      values: { launchArgs: "--x" },
    })
    expect(rejected.error?.message).toContain("unknown setting for beta: launchArgs")

    expect(
      (await call("plugin.uninstall", { id: "provider.@pigcode/provider-alpha" })).error?.message,
    ).toContain("PLUGIN_BUILTIN")
    expect((await call("agent.setDefault", { providerId: "beta" })).error).toBeUndefined()
    expect((await call("plugin.uninstall", { id: "provider.pigcode-beta" })).error).toBeUndefined()
    expect(ctx.providers.list().map((driver) => driver.id)).toEqual(["alpha"])
    // 卸载默认 agent 的插件后默认回到自动；它的设置值保留，重新安装还在。
    const after = (await call("agent.list", {})).result as { defaultProviderId: string | null }
    expect(after.defaultProviderId).toBeNull()
    expect(ctx.providers.getSettings("beta")).toEqual({
      binaryPath: "/opt/beta",
      customModels: ["beta-large"],
    })
    await ctx.fiber.dispose()
  })

  it("lists, loads and uninstalls an Agent plugin written with the new names", async () => {
    const { ctx, root } = await host()
    await ctx.plugins.loadAll()
    const source = await writeProviderPackage(
      join(root, "src-gamma"),
      "pigcode-gamma",
      "gamma",
      "agent",
    )
    await ctx.plugins.installLocal(source)
    expect(ctx.providers.list().map((driver) => driver.id)).toEqual(["alpha", "gamma"])
    const transport = new MemoryTransport()
    new RpcServer(ctx, transport.host).start()
    transport.client.send({ jsonrpc: "2.0", id: "1", method: "agent.list", params: {} })
    const listed = (await transport.client.next()) as {
      result: { agents: Array<{ providerId: string; pluginId: string; fields: unknown[] }> }
    }
    expect(listed.result.agents[1]).toMatchObject({
      providerId: "gamma",
      pluginId: "provider.pigcode-gamma",
      fields: [{ key: "binaryPath", type: "path" }],
    })
    // 卸载默认 agent 的插件时，kind 写 agent 的插件同样清掉默认选择。
    ctx.providers.setDefaultProvider("gamma")
    await uninstallPluginAndClearDefault(ctx, "provider.pigcode-gamma")
    expect(ctx.providers.configuredDefaultProvider()).toBeNull()
    await ctx.fiber.dispose()
  })

  it("keeps the default agent when another plugin is uninstalled or it is only disabled", async () => {
    const { ctx, root } = await host()
    await ctx.plugins.loadAll()
    const source = await writeProviderPackage(join(root, "src-beta"), "pigcode-beta", "beta")
    await ctx.plugins.installLocal(source)
    ctx.providers.setDefaultProvider("alpha")
    await uninstallPluginAndClearDefault(ctx, "provider.pigcode-beta")
    expect(ctx.providers.configuredDefaultProvider()).toBe("alpha")
    await ctx.plugins.disable("provider.@pigcode/provider-alpha")
    expect(ctx.providers.configuredDefaultProvider()).toBe("alpha")
    await ctx.fiber.dispose()
  })
})
