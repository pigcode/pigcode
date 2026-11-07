/** 验证本地插件安装、启停与 boot graph 输出。 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { buildBootGraph, listPlugins, setPluginEnabled } from "./plugin-manager"
import { installLocalPlugin } from "./plugin-installer"

async function fixture(engines?: { pigcode: string }) {
  const root = await mkdtemp(join(tmpdir(), "pigcode-plugin-"))
  const source = join(root, "ui-debug-panel")
  await mkdir(source)
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name: "pigcode-ui-debug-panel",
      version: "0.0.0",
      engines,
      pigcode: {
        apiVersion: 1,
        kind: "ui",
        client: "./client.mjs",
        permissions: ["ui:panel"],
        provides: ["ui:debug-panel"],
        contributes: { "x-note": "kept" },
      },
    }),
  )
  await writeFile(join(source, "client.mjs"), "export function apply() {}\n")
  return { root, source }
}

/** 一个带 client 入口的 UI 插件源目录；name 决定包名与插件 id。 */
async function writeUiPlugin(
  root: string,
  options: {
    name: string
    provides?: string[]
    apiVersion?: number
    engines?: { pigcode: string }
  },
): Promise<string> {
  const source = join(root, `src-${options.name}`)
  await mkdir(source, { recursive: true })
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name: options.name,
      version: "0.0.0",
      engines: options.engines,
      pigcode: {
        apiVersion: options.apiVersion ?? 1,
        kind: "ui",
        client: "./client.mjs",
        provides: options.provides ?? [],
      },
    }),
  )
  await writeFile(join(source, "client.mjs"), "export function apply() {}\n")
  return source
}

describe("plugin manager", () => {
  it("installs a local plugin and toggles it", async () => {
    const { root, source } = await fixture()
    const entry = await installLocalPlugin(root, source)
    expect(entry.id).toContain("pigcode-ui-debug-panel")

    const enabledGraph = await buildBootGraph(root)
    expect(enabledGraph.entries).toHaveLength(1)
    expect(enabledGraph.entries[0]?.url).toContain("/client.mjs?rev=")

    await setPluginEnabled(root, entry.id, false)
    const graph = await buildBootGraph(root)
    expect(graph.entries).toHaveLength(0)
  })

  it("lists installed plugins with enabled state", async () => {
    const { root, source } = await fixture()
    await installLocalPlugin(root, source)
    const plugins = await listPlugins(root)
    expect(plugins).toHaveLength(1)
    expect(plugins[0]?.enabled).toBe(true)
    expect(plugins[0]?.apiVersion).toBe(1)
    expect(plugins[0]?.permissions).toEqual(["ui:panel"])
    expect(plugins[0]?.provides).toEqual(["ui:debug-panel"])
    expect(plugins[0]?.contributes).toEqual({ "x-note": "kept" })
    expect(plugins[0]?.conflict).toBeNull()
    expect(plugins[0]?.error).toBeNull()
  })

  it("keeps manifest details but reports incompatible engines", async () => {
    const { root, source } = await fixture({ pigcode: ">=99.0.0" })
    await installLocalPlugin(root, source)
    const plugins = await listPlugins(root)
    expect(plugins[0]?.name).toBe("pigcode-ui-debug-panel")
    expect(plugins[0]?.error).toContain("engines")
  })

  it("reports the apiVersion the plugin needs and the one the host supports", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-plugin-"))
    await installLocalPlugin(root, await writeUiPlugin(root, { name: "ui-future", apiVersion: 2 }))
    const [plugin] = await listPlugins(root)
    expect(plugin?.apiVersion).toBe(2)
    expect(plugin?.error).toBe("unsupported plugin apiVersion: 2; this Host supports 1")
  })

  it("leaves an errored plugin's client code out of the boot graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-plugin-"))
    await installLocalPlugin(root, await writeUiPlugin(root, { name: "ui-future", apiVersion: 2 }))
    await installLocalPlugin(
      root,
      await writeUiPlugin(root, { name: "ui-old", engines: { pigcode: ">=99.0.0" } }),
    )
    await installLocalPlugin(root, await writeUiPlugin(root, { name: "ui-ok" }))

    expect((await buildBootGraph(root)).entries.map((entry) => entry.id)).toEqual(["ui.ui-ok"])
  })

  it("keeps the first plugin that provides a service and leaves the later one out", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-plugin-"))
    await installLocalPlugin(root, await writeUiPlugin(root, { name: "ui-a", provides: ["ui:x"] }))
    await installLocalPlugin(root, await writeUiPlugin(root, { name: "ui-b", provides: ["ui:x"] }))

    // 安装本身不拦：先装好的 a 保留，后装的 b 标记为冲突。
    const plugins = await listPlugins(root)
    expect(plugins.find((plugin) => plugin.id === "ui.ui-a")).toMatchObject({
      conflict: null,
      error: null,
    })
    expect(plugins.find((plugin) => plugin.id === "ui.ui-b")).toMatchObject({
      conflict: "PROVIDES_CONFLICT: ui:x is already provided by ui.ui-a",
    })
    // 冲突插件的界面代码不加载。
    expect((await buildBootGraph(root)).entries.map((entry) => entry.id)).toEqual(["ui.ui-a"])

    // 停用先加载的 a 后，b 不再是冲突，界面代码随之加载。
    await setPluginEnabled(root, "ui.ui-a", false)
    expect((await listPlugins(root)).find((plugin) => plugin.id === "ui.ui-b")?.conflict).toBeNull()
    expect((await buildBootGraph(root)).entries.map((entry) => entry.id)).toEqual(["ui.ui-b"])
  })

  it("filters an errored plugin's client code out of the boot graph by host failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-plugin-"))
    await installLocalPlugin(root, await writeUiPlugin(root, { name: "ui-a" }))
    await installLocalPlugin(root, await writeUiPlugin(root, { name: "ui-b" }))

    const graph = await buildBootGraph(root, new Set(["ui.ui-b"]))
    expect(graph.entries.map((entry) => entry.id)).toEqual(["ui.ui-a"])
  })
})
