/** 验证本地插件安装、启停与 boot graph 输出。 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { buildBootGraph, installLocalPlugin, listPlugins, setPluginEnabled } from "./plugin-manager"

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
        contributes: { slots: ["workbench.right"] },
      },
    }),
  )
  await writeFile(join(source, "client.mjs"), "export function apply() {}\n")
  return { root, source }
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
    expect(plugins[0]?.contributes).toEqual({ slots: ["workbench.right"] })
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
})
