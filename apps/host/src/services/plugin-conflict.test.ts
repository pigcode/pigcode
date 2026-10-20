/** 验证 provides 重复时启用被拒绝，且摘要能展示冲突原因。 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { installLocalPlugin, listPlugins, setPluginEnabled } from "./plugin-manager"

/** 写入一个只声明 host 入口的 provider 插件源目录。 */
async function writeProvider(root: string, name: string, provides: string[]): Promise<string> {
  const source = join(root, `src-${name}`)
  await mkdir(source, { recursive: true })
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name,
      version: "0.0.0",
      pigcode: { apiVersion: 1, kind: "provider", host: "./index.mjs", provides },
    }),
  )
  await writeFile(join(source, "index.mjs"), "export function apply() {}\n")
  return source
}

/** 安装两个 provide 同一能力的 provider，并停用第二个以便测试重新启用。 */
async function fixtureWithTwoProviders(): Promise<{ profileDir: string }> {
  const profileDir = await mkdtemp(join(tmpdir(), "pigcode-conflict-"))
  await installLocalPlugin(profileDir, await writeProvider(profileDir, "a", ["provider:echo"]))
  await installLocalPlugin(profileDir, await writeProvider(profileDir, "b", ["provider:echo"]))
  await setPluginEnabled(profileDir, "provider.b", false)
  return { profileDir }
}

describe("plugin provides conflict", () => {
  it("rejects enabling a plugin with a duplicate provides", async () => {
    const { profileDir } = await fixtureWithTwoProviders()

    await expect(setPluginEnabled(profileDir, "provider.b", true)).rejects.toMatchObject({
      code: "PROVIDES_CONFLICT",
    })
    await expect(setPluginEnabled(profileDir, "provider.b", true)).rejects.toThrow(
      "PROVIDES_CONFLICT",
    )

    const plugins = await listPlugins(profileDir)
    expect(plugins.find((plugin) => plugin.id === "provider.b")?.enabled).toBe(false)
    // 停用状态下不构成冲突。
    expect(plugins.map((plugin) => plugin.conflict)).toEqual([null, null])
  })

  it("reports the conflict on every enabled summary", async () => {
    const { profileDir } = await fixtureWithTwoProviders()

    // 安装写 profile 时不检查冲突，用它构造一个已冲突的 profile 验证 list 的展示。
    await installLocalPlugin(profileDir, await writeProvider(profileDir, "b", ["provider:echo"]))

    const plugins = await listPlugins(profileDir)
    const summaryA = plugins.find((plugin) => plugin.id === "provider.a")
    const summaryB = plugins.find((plugin) => plugin.id === "provider.b")
    expect(summaryA?.conflict).toContain("PROVIDES_CONFLICT")
    expect(summaryA?.conflict).toContain("provider:echo")
    expect(summaryB?.conflict).toContain("provider:echo")
  })

  it("allows enabling plugins whose provides do not overlap", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "pigcode-conflict-"))
    await installLocalPlugin(profileDir, await writeProvider(profileDir, "a", ["provider:echo"]))
    await installLocalPlugin(profileDir, await writeProvider(profileDir, "b", ["provider:other"]))

    await expect(setPluginEnabled(profileDir, "provider.b", true)).resolves.toMatchObject({
      id: "provider.b",
      disabled: false,
    })
    const plugins = await listPlugins(profileDir)
    expect(plugins.every((plugin) => plugin.conflict === null)).toBe(true)
  })
})
