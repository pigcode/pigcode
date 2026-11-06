/** 验证 Host 插件启用/停用无需重启即可生效。 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { installLocalPlugin } from "./plugin-manager"
import { setupHost } from "./plugin-harness"

/** 写入一个注册 echo agent 的最小 Host 插件源目录。 */
async function fixtureAgentPlugin(): Promise<string> {
  const source = await mkdtemp(join(tmpdir(), "pigcode-fixture-agent-"))
  await mkdir(source, { recursive: true })
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name: "pigcode-agent-echo-fixture",
      version: "0.1.0",
      type: "module",
      main: "./index.mjs",
      pigcode: {
        apiVersion: 1,
        kind: "agent",
        displayName: "Echo",
        host: "./index.mjs",
        provides: ["agent:echo"],
        permissions: [],
      },
    }),
  )
  await writeFile(
    join(source, "index.mjs"),
    [
      'export const inject = ["agents"]',
      "export function apply(ctx) {",
      "  ctx.agents.register({",
      '    id: "echo",',
      '    displayName: "Echo",',
      "    features: {},",
      "    createSession: async () => ({}),",
      "    send: async () => {},",
      "    interrupt: async () => {},",
      "    dispose: async () => {},",
      "  })",
      '  ctx.effect(() => () => ctx.agents.unregister("echo"))',
      "}",
      "",
    ].join("\n"),
  )
  return source
}

describe("dynamic host plugin", () => {
  it("loads and unloads a host plugin without restart", async () => {
    const { ctx, profileDir } = await setupHost({ prefix: "pigcode-dynamic-" })
    const plugin = await installLocalPlugin(profileDir, await fixtureAgentPlugin())

    await ctx.plugins.enable(plugin.id)
    await ctx.loader.await()
    expect(ctx.agents.list().some((agent) => agent.id === "echo")).toBe(true)

    await ctx.plugins.disable(plugin.id)
    await ctx.loader.await()
    expect(ctx.agents.list().some((agent) => agent.id === "echo")).toBe(false)

    await ctx.fiber.dispose()
  })
})
