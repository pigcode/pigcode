/** 验证插件出错后的收敛：冲突的插件不留在 loader 里，修好的入口刷新一次就能回来。 */
import Loader from "@cordisjs/plugin-loader"
import { Context } from "cordis"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { stringify } from "yaml"
import { apply as agentsPlugin } from "../agents/registry"
import { apply as pluginsPlugin } from "./plugins"
import { apply as projects } from "./projects"
import { apply as sessions } from "./sessions"
import { apply as settings } from "./settings"
import { apply as storage } from "./storage"
import { apply as threads } from "./threads"

/** 临时 profile 与空的 loader。 */
async function host() {
  const root = await mkdtemp(join(tmpdir(), "pigcode-plugin-errors-"))
  const profileDir = join(root, "profile")
  await mkdir(profileDir, { recursive: true })
  const ctx = new Context()
  const base = pathToFileURL(root).href
  await ctx.plugin(Loader, { baseUrl: `${base}/` })
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(settings)
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agentsPlugin, { fake: false })
  await ctx.plugin(pluginsPlugin, { profileDir, builtin: [] })
  return { ctx, root, profileDir }
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

describe("plugin errors in the host", () => {
  it("drops a plugin's Host entry once it stops owning its provides, and picks up the plugin that takes over", async () => {
    const { ctx, profileDir } = await host()
    // 两个插件各提供一个服务，都装、都启用。
    for (const name of ["pigcode-a", "pigcode-b"]) {
      await writePluginPackage(join(profileDir, "node_modules", name), {
        name,
        provides: [`ui:${name}`],
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
    await ctx.plugins.loadAll()
    expect((await ctx.plugins.bootGraph()).entries.map((entry) => entry.id)).toEqual([
      "ui.pigcode-a",
      "ui.pigcode-b",
    ])

    // 重装第一个，让它改去声明第二个的服务。列表顺序里它在前面，所以它先占位、第二个改为冲突；
    // reconcile 据此卸掉第二个的 Host 入口——插件页说冲突的插件不会还在跑。
    await writePluginPackage(join(profileDir, "node_modules", "pigcode-a"), {
      name: "pigcode-a",
      provides: ["ui:pigcode-b"],
    })
    await ctx.plugins.reload()
    const listed = await ctx.plugins.list()
    expect(listed.find((plugin) => plugin.id === "ui.pigcode-a")?.conflict).toBeNull()
    expect(listed.find((plugin) => plugin.id === "ui.pigcode-b")?.conflict).toBe(
      "PROVIDES_CONFLICT: ui:pigcode-b is already provided by ui.pigcode-a",
    )
    expect((await ctx.plugins.bootGraph()).entries.map((entry) => entry.id)).toEqual([
      "ui.pigcode-a",
    ])

    // 停用第一个后，第二个不再冲突，接上服务。
    await ctx.plugins.disable("ui.pigcode-a")
    expect(
      (await ctx.plugins.list()).find((plugin) => plugin.id === "ui.pigcode-b")?.conflict,
    ).toBe(null)
    expect((await ctx.plugins.bootGraph()).entries.map((entry) => entry.id)).toEqual([
      "ui.pigcode-b",
    ])
    await ctx.fiber.dispose()
  })

  it("retries a failed Host entry when its files are replaced, without disabling the plugin first", async () => {
    const { ctx, profileDir } = await host()
    // 入口 apply 抛错；先加载时只记错误，Host 照常启动。
    await writePluginPackage(join(profileDir, "node_modules", "pigcode-broken"), {
      name: "pigcode-broken",
      provides: ["ui:broken"],
      body: "export function apply() { throw new Error('boom') }\n",
    })
    await writeFile(
      join(profileDir, "plugins.yml"),
      stringify({ plugins: [{ id: "ui.pigcode-broken", name: "pigcode-broken" }] }),
    )
    await ctx.plugins.loadAll()
    expect(
      (await ctx.plugins.list()).find((plugin) => plugin.id === "ui.pigcode-broken")?.error,
    ).toBe("plugin host entry failed to apply: boom")
    expect(ctx.plugins.hostFailures().has("ui.pigcode-broken")).toBe(true)
    expect((await ctx.plugins.bootGraph()).entries).toEqual([])

    // 修好入口、换一个新的入口文件后刷新一次：不先停用也能重新加载，错误清掉，界面代码一起回来。
    // 换文件名是因为 Node 按 URL 缓存模块，同一个路径不会重新 import。
    await writePluginPackage(join(profileDir, "node_modules", "pigcode-broken"), {
      name: "pigcode-broken",
      provides: ["ui:broken"],
      entry: "fixed.mjs",
      host: "./fixed.mjs",
    })
    await ctx.plugins.reload()
    expect(
      (await ctx.plugins.list()).find((plugin) => plugin.id === "ui.pigcode-broken")?.error,
    ).toBe(null)
    expect(ctx.plugins.hostFailures().has("ui.pigcode-broken")).toBe(false)
    expect((await ctx.plugins.bootGraph()).entries.map((entry) => entry.id)).toEqual([
      "ui.pigcode-broken",
    ])
    await ctx.fiber.dispose()
  })
})
