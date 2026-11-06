/**
 * 停用插件后，它的清理真的跑了（#6 缺口 E）。
 *
 * #6 原文要求「UI、Host 服务、子进程全部移除」。前两项已有覆盖（`plugins-dynamic.test.ts`、
 * `agent-catalog.test.ts`）。这一条补最后一项：插件自己起的进程，停用后必须结束。
 *
 * 关键在于 Cordis 的清理是 async 的：`unloadEntry` 会 await 插件 fiber，插件用自己的
 * `ctx.effect` 结束子进程。这里让插件在 apply 里起一个真实的孙进程，并在 effect 里等它退出，
 * 断言 disable 返回时进程已经不在——不是「稍后会被收」，而是 unloadEntry 真的等了。
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { installLocalPlugin } from "./plugin-manager"
import { setupHost } from "./plugin-harness"

/** 插件清理里故意加的一段延时；见 pluginSource。 */
const CLEANUP_MS = 300

/** 进程是否还活着。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 写成安静的 string，避免每个用例都重复转义。
 * 清理里故意等一小会儿：`unloadEntry` 只有真的 await 了插件 fiber，disable 才会变慢；
 * 如果它不看清理结果就返回，这个延时不会出现在 disable 的耗时里。
 */
function pluginSource(): string {
  return [
    'import { spawn } from "node:child_process"',
    "",
    "export function apply(ctx) {",
    "  // 插件自己起的子进程：停用后必须结束。",
    '  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {',
    '    stdio: "ignore",',
    "  })",
    "  ctx.effect(() => async () => {",
    "    child.kill()",
    "    if (child.exitCode === null) {",
    '      await new Promise((resolve) => child.once("exit", resolve))',
    "    }",
    "    // 清理真的跑完了才返回；disable 要等它。",
    `    await new Promise((resolve) => setTimeout(resolve, ${CLEANUP_MS}))`,
    "  })",
    "  globalThis.__pluginChildPid = child.pid",
    "}",
    "",
  ].join("\n")
}

/** 写一个只是起子进程的 Host 插件源目录。 */
async function fixtureChildPlugin(): Promise<string> {
  const source = await mkdtemp(join(tmpdir(), "pigcode-fixture-child-"))
  await mkdir(source, { recursive: true })
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name: "pigcode-child-fixture",
      version: "0.1.0",
      type: "module",
      main: "./index.mjs",
      pigcode: {
        apiVersion: 1,
        kind: "capability",
        host: "./index.mjs",
        provides: [],
        permissions: [],
      },
    }),
  )
  await writeFile(join(source, "index.mjs"), pluginSource())
  return source
}

describe("disabling a plugin ends the processes it started", { timeout: 30_000 }, () => {
  it("waits for the plugin's own cleanup before reporting the plugin as disabled", async () => {
    const { ctx, profileDir } = await setupHost({ prefix: "pigcode-plugin-child-" })
    const plugin = await installLocalPlugin(profileDir, await fixtureChildPlugin())
    const globals = globalThis as { __pluginChildPid?: number }
    try {
      await ctx.plugins.enable(plugin.id)
      await ctx.loader.await()
      const pid = globals.__pluginChildPid
      expect(pid, "the plugin should have started a child process").toBeTypeOf("number")
      expect(isAlive(pid!)).toBe(true)

      const startedAt = Date.now()
      await ctx.plugins.disable(plugin.id)
      const elapsed = Date.now() - startedAt
      await ctx.loader.await()

      // disable 等过插件的清理：耗时会包含清理里的延时。
      expect(elapsed).toBeGreaterThanOrEqual(CLEANUP_MS - 20)
      // 不轮询、不 sleep：disable 已经等过插件的 effect，进程此刻就该没了。
      expect(isAlive(pid!)).toBe(false)
    } finally {
      const pid = globals.__pluginChildPid
      if (pid !== undefined && isAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          // 已经不在了。
        }
      }
      delete globals.__pluginChildPid
      await ctx.fiber.dispose()
    }
  })
})
