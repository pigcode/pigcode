/** 验证 Host 插件启用/停用无需重启即可生效。 */
import Loader from "@cordisjs/plugin-loader"
import { Context } from "cordis"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { apply as providers } from "../providers/registry"
import { installLocalPlugin } from "./plugin-manager"
import { apply as pluginsPlugin } from "./plugins"
import { apply as projects } from "./projects"
import { apply as sessions } from "./sessions"
import { apply as storage } from "./storage"
import { apply as threads } from "./threads"

/** 创建带 loader、providers 与 plugins 服务的 Host 测试上下文。 */
async function setupHost(): Promise<{ ctx: Context; profileDir: string }> {
  const profileDir = await mkdtemp(join(tmpdir(), "pigcode-dynamic-"))
  // loader 以 profileDir 为解析作用域；package.json 让裸包名解析到 node_modules。
  await writeFile(
    join(profileDir, "package.json"),
    JSON.stringify({ name: "pigcode-profile", version: "0.0.0", private: true }),
  )
  const ctx = new Context()
  const base = pathToFileURL(profileDir).href
  await ctx.plugin(Loader, { baseUrl: base.endsWith("/") ? base : `${base}/` })
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(providers)
  await ctx.plugin(pluginsPlugin, { profileDir })
  return { ctx, profileDir }
}

/** 写入一个注册 echo provider 的最小 Host 插件源目录。 */
async function fixtureProviderPlugin(): Promise<string> {
  const source = await mkdtemp(join(tmpdir(), "pigcode-fixture-provider-"))
  await mkdir(source, { recursive: true })
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name: "pigcode-provider-echo-fixture",
      version: "0.1.0",
      type: "module",
      main: "./index.mjs",
      pigcode: {
        apiVersion: 1,
        kind: "provider",
        displayName: "Echo",
        host: "./index.mjs",
        provides: ["provider:echo"],
        permissions: [],
      },
    }),
  )
  await writeFile(
    join(source, "index.mjs"),
    [
      'export const inject = ["providers"]',
      "export function apply(ctx) {",
      "  ctx.providers.register({",
      '    id: "echo",',
      '    displayName: "Echo",',
      "    capabilities: {},",
      "    createSession: async () => ({}),",
      "    send: async () => {},",
      "    interrupt: async () => {},",
      "    dispose: async () => {},",
      "  })",
      '  ctx.effect(() => () => ctx.providers.unregister("echo"))',
      "}",
      "",
    ].join("\n"),
  )
  return source
}

describe("dynamic host plugin", () => {
  it("loads and unloads a host plugin without restart", async () => {
    const { ctx, profileDir } = await setupHost()
    const plugin = await installLocalPlugin(profileDir, await fixtureProviderPlugin())

    await ctx.plugins.enable(plugin.id)
    await ctx.loader.await()
    expect(ctx.providers.list().some((provider) => provider.id === "echo")).toBe(true)

    await ctx.plugins.disable(plugin.id)
    await ctx.loader.await()
    expect(ctx.providers.list().some((provider) => provider.id === "echo")).toBe(false)

    await ctx.fiber.dispose()
  })
})
