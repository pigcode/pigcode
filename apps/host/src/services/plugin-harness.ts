/**
 * 插件相关的 Host 测试共用同一套上下文：loader、内存数据库、项目/线程/事件、agents 与 plugins。
 * 各用例只差一个额外插件（mcp bridge、settings 等），所以额外插件由调用方通过 `extra` 传。
 */
import Loader from "@cordisjs/plugin-loader"
import { Context, type Plugin } from "cordis"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { apply as agentsPlugin } from "../agents/registry"
import { apply as pluginsPlugin } from "./plugins"
import { apply as projects } from "./projects"
import { apply as sessions } from "./sessions"
import { apply as storage } from "./storage"
import { apply as threads } from "./threads"

/** 已经装好的 Host 上下文，以及插件安装用的 profile 目录。 */
export interface HostHarness {
  ctx: Context
  profileDir: string
}

/**
 * 建一个可以安装/启用/停用宿主插件的 Context。
 * `extra` 里的插件在 plugins 之前加载，顺序和其他用例一致。
 */
export async function setupHost(
  options: { prefix?: string; extra?: Plugin[] } = {},
): Promise<HostHarness> {
  const profileDir = await mkdtemp(join(tmpdir(), options.prefix ?? "pigcode-plugins-"))
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
  for (const plugin of options.extra ?? []) await ctx.plugin(plugin)
  await ctx.plugin(agentsPlugin)
  await ctx.plugin(pluginsPlugin, { profileDir })
  return { ctx, profileDir }
}
