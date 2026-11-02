/** 验证 provides 重复时启用被拒绝，且摘要能展示冲突原因。 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { installLocalPlugin, listPlugins, setPluginEnabled } from "./plugin-manager"

/** 写入一个只声明 host 入口的 Agent 插件源目录。 */
async function writeAgent(root: string, name: string, provides: string[]): Promise<string> {
  const source = join(root, `src-${name}`)
  await mkdir(source, { recursive: true })
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name,
      version: "0.0.0",
      pigcode: { apiVersion: 1, kind: "agent", host: "./index.mjs", provides },
    }),
  )
  await writeFile(join(source, "index.mjs"), "export function apply() {}\n")
  return source
}

/** 安装两个 provide 同一个 provides 的 Agent 插件，并停用第二个以便测试重新启用。 */
async function fixtureWithTwoAgents(): Promise<{ profileDir: string }> {
  const profileDir = await mkdtemp(join(tmpdir(), "pigcode-conflict-"))
  await installLocalPlugin(profileDir, await writeAgent(profileDir, "a", ["agent:echo"]))
  await installLocalPlugin(profileDir, await writeAgent(profileDir, "b", ["agent:echo"]))
  await setPluginEnabled(profileDir, "agent.b", false)
  return { profileDir }
}

describe("plugin provides conflict", () => {
  it("rejects enabling a plugin with a duplicate provides", async () => {
    const { profileDir } = await fixtureWithTwoAgents()

    await expect(setPluginEnabled(profileDir, "agent.b", true)).rejects.toMatchObject({
      code: "PROVIDES_CONFLICT",
    })
    await expect(setPluginEnabled(profileDir, "agent.b", true)).rejects.toThrow("PROVIDES_CONFLICT")

    const plugins = await listPlugins(profileDir)
    expect(plugins.find((plugin) => plugin.id === "agent.b")?.enabled).toBe(false)
    // 停用状态下不构成冲突。
    expect(plugins.map((plugin) => plugin.conflict)).toEqual([null, null])
  })

  it("reports the conflict on every enabled summary", async () => {
    const { profileDir } = await fixtureWithTwoAgents()

    // 安装写 profile 时不检查冲突，用它构造一个已冲突的 profile 验证 list 的展示。
    await installLocalPlugin(profileDir, await writeAgent(profileDir, "b", ["agent:echo"]))

    const plugins = await listPlugins(profileDir)
    const summaryA = plugins.find((plugin) => plugin.id === "agent.a")
    const summaryB = plugins.find((plugin) => plugin.id === "agent.b")
    expect(summaryA?.conflict).toContain("PROVIDES_CONFLICT")
    expect(summaryA?.conflict).toContain("agent:echo")
    expect(summaryB?.conflict).toContain("agent:echo")
  })

  it("allows enabling plugins whose provides do not overlap", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "pigcode-conflict-"))
    await installLocalPlugin(profileDir, await writeAgent(profileDir, "a", ["agent:echo"]))
    await installLocalPlugin(profileDir, await writeAgent(profileDir, "b", ["agent:other"]))

    await expect(setPluginEnabled(profileDir, "agent.b", true)).resolves.toMatchObject({
      id: "agent.b",
      disabled: false,
    })
    const plugins = await listPlugins(profileDir)
    expect(plugins.every((plugin) => plugin.conflict === null)).toBe(true)
  })
})
