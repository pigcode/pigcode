/** 验证 Capability 样例：安装启用后提供 sessionInfo，停用后服务随之消失。 */
import { Context } from "cordis"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { installLocalPlugin } from "./plugin-manager"
import { setupHost } from "./plugin-harness"

/** 仓库内的 Capability 样例目录；测试按安装路径复制，走真实的本地安装流程。 */
const SAMPLE_SOURCE = fileURLToPath(
  new URL("../../../../examples/capability-session-info", import.meta.url),
)

/** 安装并启用 Capability 样例。 */
async function installCapabilitySample(): Promise<{ ctx: Context }> {
  const { ctx, profileDir } = await setupHost({ prefix: "pigcode-capability-" })
  const plugin = await installLocalPlugin(profileDir, SAMPLE_SOURCE)
  await ctx.plugins.enable(plugin.id)
  await ctx.loader.await()
  return { ctx }
}

describe("Capability plugin sample", () => {
  it("loads and unloads the Capability sample", async () => {
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
