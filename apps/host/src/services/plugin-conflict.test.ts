/** 验证 provides 重复时启用被拒绝，且摘要能展示冲突原因。 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parse, stringify } from "yaml"
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

/** 把 plugins.yml 里的条目全部改成启用，模拟两个冲突插件都启用的列表。 */
async function writeBothEnabled(profileDir: string): Promise<void> {
  const path = join(profileDir, "plugins.yml")
  const parsed = parse(await readFile(path, "utf8")) as {
    plugins: Array<{ id: string; disabled?: boolean }>
  }
  for (const entry of parsed.plugins) delete entry.disabled
  await writeFile(path, stringify(parsed))
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

  it("keeps the first loaded plugin and marks the later one as a conflict", async () => {
    const { profileDir } = await fixtureWithTwoAgents()
    // 重新启用 b 会被拒绝；直接改 plugins.yml 构造“两个都启用”的列表，模拟安装时已冲突的 profile。
    await writeBothEnabled(profileDir)

    const plugins = await listPlugins(profileDir)
    const summaryA = plugins.find((plugin) => plugin.id === "agent.a")
    const summaryB = plugins.find((plugin) => plugin.id === "agent.b")
    // 先加载的 a 保留，不受影响。
    expect(summaryA?.conflict).toBeNull()
    expect(summaryA?.error).toBeNull()
    // 后加载的 b 标记为冲突，说明冲突的服务标识和先加载的插件。
    expect(summaryB?.conflict).toBe("PROVIDES_CONFLICT: agent:echo is already provided by agent.a")
    expect(summaryB?.error).toBe(summaryB?.conflict)
  })

  it("marks a plugin that declares the same provides twice as a conflict", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "pigcode-conflict-"))
    await installLocalPlugin(
      profileDir,
      await writeAgent(profileDir, "a", ["agent:echo", "agent:echo"]),
    )

    const [plugin] = await listPlugins(profileDir)
    expect(plugin?.conflict).toBe("PROVIDES_CONFLICT: agent:echo is declared more than once")
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

describe("conflicts stay in step with what is loaded", () => {
  it("keeps the conflict reason in step with the services that are actually left", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "pigcode-conflict-"))
    // a 提供 x；b 同时声明 x 和 y，整条因 x 冲突不加载；c 独立提供 y。
    await installLocalPlugin(profileDir, await writeAgent(profileDir, "a", ["svc:x"]))
    await installLocalPlugin(profileDir, await writeAgent(profileDir, "b", ["svc:x", "svc:y"]))
    await installLocalPlugin(profileDir, await writeAgent(profileDir, "c", ["svc:y"]))
    const before = await listPlugins(profileDir)
    expect(before.find((plugin) => plugin.id === "agent.b")?.conflict).toBe(
      "PROVIDES_CONFLICT: svc:x is already provided by agent.a",
    )

    // 停用 a 后 x 空出来，列表顺序里的 b 拿到 x 和 y，轮到 c 时 y 已被 b 占用。
    // 冲突跟着重新计算的结果走，不会停留在旧的原因上。
    await setPluginEnabled(profileDir, "agent.a", false)
    const moved = await listPlugins(profileDir)
    expect(moved.find((plugin) => plugin.id === "agent.a")?.conflict).toBeNull()
    expect(moved.find((plugin) => plugin.id === "agent.b")?.conflict).toBeNull()
    expect(moved.find((plugin) => plugin.id === "agent.c")?.conflict).toBe(
      "PROVIDES_CONFLICT: svc:y is already provided by agent.b",
    )
  })

  it("enables a plugin whose service is only claimed by plugins that are not loaded", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "pigcode-conflict-"))
    await installLocalPlugin(profileDir, await writeAgent(profileDir, "a", ["svc:x"]))
    // b 声明 x 和 y，因 x 冲突不加载；它并不占着 y。
    await installLocalPlugin(profileDir, await writeAgent(profileDir, "b", ["svc:x", "svc:y"]))
    await installLocalPlugin(profileDir, await writeAgent(profileDir, "c", ["svc:y"]))
    await setPluginEnabled(profileDir, "agent.c", false)

    // c 启用时只和真正在提供 y 的插件比；b 没加载，不算。
    await expect(setPluginEnabled(profileDir, "agent.c", true)).resolves.toMatchObject({
      id: "agent.c",
      disabled: false,
    })
  })

  it("allows disabling a winner and enabling it again once the loser is disabled too", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "pigcode-conflict-"))
    await installLocalPlugin(profileDir, await writeAgent(profileDir, "a", ["svc:x"]))
    await installLocalPlugin(profileDir, await writeAgent(profileDir, "b", ["svc:x"]))
    await setPluginEnabled(profileDir, "agent.b", false)
    await setPluginEnabled(profileDir, "agent.a", false)
    await expect(setPluginEnabled(profileDir, "agent.b", true)).resolves.toMatchObject({
      id: "agent.b",
    })
  })
})
