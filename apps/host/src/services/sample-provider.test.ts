/** 验证第三方 provider 样例：从仓库 examples 安装、热启用并完成一次 run。 */
import Loader from "@cordisjs/plugin-loader"
import { Context } from "cordis"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import type { Thread } from "@pigcode/contracts"
import { apply as providers } from "../providers/registry"
import { installLocalPlugin } from "./plugin-manager"
import { apply as pluginsPlugin } from "./plugins"
import { apply as projects } from "./projects"
import { apply as sessions } from "./sessions"
import { apply as storage } from "./storage"
import { apply as threads } from "./threads"

/** 仓库内的 echo 样例目录；测试按安装路径复制，走真实的本地安装流程。 */
const ECHO_SOURCE = fileURLToPath(new URL("../../../../examples/provider-echo", import.meta.url))

/** 创建带 loader、providers 与 plugins 服务的 Host 测试上下文。 */
async function setupHost(): Promise<{ ctx: Context; profileDir: string }> {
  const profileDir = await mkdtemp(join(tmpdir(), "pigcode-echo-"))
  // loader 以 profileDir 为解析作用域；package.json 让裸包名解析到 node_modules。
  await writeFile(
    join(profileDir, "package.json"),
    JSON.stringify({ name: "pigcode-profile", version: "0.0.0", private: true }),
  )
  const ctx = new Context()
  const base = pathToFileURL(profileDir).href
  const baseUrl = base.endsWith("/") ? base : `${base}/`
  await ctx.plugin(Loader, { baseUrl })
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(providers)
  await ctx.plugin(pluginsPlugin, { profileDir })
  return { ctx, profileDir }
}

/** 安装并启用 echo 样例，返回可发起 run 的线程。 */
async function installEchoProvider(): Promise<{ ctx: Context; thread: Thread }> {
  const { ctx, profileDir } = await setupHost()
  const plugin = await installLocalPlugin(profileDir, ECHO_SOURCE)
  await ctx.plugins.enable(plugin.id)
  await ctx.loader.await()
  const project = ctx.projects.add(await mkdtemp(join(tmpdir(), "pigcode-echo-project-")))
  const thread = ctx.threads.create(project.id, "Echo", "echo")
  return { ctx, thread }
}

describe("echo provider plugin", () => {
  it("loads the echo provider plugin and completes a run", async () => {
    const { ctx, thread } = await installEchoProvider()
    try {
      const { done } = await ctx.providers.startRun(thread.id, "hello")
      await done
      const events = ctx.sessions.read(thread.id, 0)
      expect(events.some((event) => event.type === "message.completed")).toBe(true)
      // 样例把用户输入原样回显；确认 assistant 消息确实来自 echo，而不是用户消息回执。
      expect(
        events.some((event) => {
          if (event.type !== "message.completed") return false
          const payload = event.payload as { role?: unknown; text?: unknown }
          return payload.role === "assistant" && payload.text === "hello"
        }),
      ).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
