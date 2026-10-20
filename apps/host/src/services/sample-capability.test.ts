/** 验证 capability 样例：安装启用后提供 sessionInfo，停用后服务随之消失。 */
import Loader from "@cordisjs/plugin-loader"
import { Context } from "cordis"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { apply as providers } from "../providers/registry"
import { installLocalPlugin } from "./plugin-manager"
import { apply as pluginsPlugin } from "./plugins"
import { apply as projects } from "./projects"
import { apply as sessions } from "./sessions"
import { apply as storage } from "./storage"
import { apply as threads } from "./threads"

/** 仓库内的 capability 样例目录；测试按安装路径复制，走真实的本地安装流程。 */
const SAMPLE_SOURCE = fileURLToPath(
  new URL("../../../../examples/capability-session-info", import.meta.url),
)

/** 创建带 loader、sessions 与 plugins 服务的 Host 测试上下文。 */
async function setupHost(): Promise<{ ctx: Context; profileDir: string }> {
  const profileDir = await mkdtemp(join(tmpdir(), "pigcode-capability-"))
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

/** 安装并启用 capability 样例。 */
async function installCapabilitySample(): Promise<{ ctx: Context }> {
  const { ctx, profileDir } = await setupHost()
  const plugin = await installLocalPlugin(profileDir, SAMPLE_SOURCE)
  await ctx.plugins.enable(plugin.id)
  await ctx.loader.await()
  return { ctx }
}

describe("capability plugin sample", () => {
  it("loads and unloads the capability sample", async () => {
    const { ctx } = await installCapabilitySample()
    try {
      expect(ctx.reflect.get("sessionInfo")).toBeTruthy()
      await ctx.plugins.disable("capability.pigcode-capability-session-info")
      await ctx.loader.await()
      expect(ctx.reflect.get("sessionInfo")).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
