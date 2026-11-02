/** 验证内置插件：随 Host 启动加载、可停用不可卸载、不能被同名包覆盖；用户插件可以卸载。 */
import Loader from "@cordisjs/plugin-loader"
import { Context } from "cordis"
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { apply as agentsPlugin } from "../agents/registry"
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
    return { ctx, root, env }
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
