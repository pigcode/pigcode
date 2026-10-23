/** 验证自定义协议：路径不越出根目录，boot.json 缺失时返回空启动图，插件文件缺失时 404。 */
import { describe, expect, it } from "vitest"
import { handlePluginRequest, resolveInside } from "./protocol"

/** 只认识给定文件的读取替身。 */
function files(entries: Record<string, string>): (path: string) => Promise<Buffer<ArrayBuffer>> {
  return async (path) => {
    const content = entries[path]
    if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" })
    return Buffer.from(content)
  }
}

describe("protocol path resolution", () => {
  it("resolves a file inside the root", () => {
    expect(resolveInside("/tmp/root", "client.js")).toBe("/tmp/root/client.js")
  })

  it("rejects a traversal path", () => {
    expect(() => resolveInside("/tmp/root", "../secret")).toThrow()
  })
})

describe("pigcode-plugin requests", () => {
  it("serves an empty boot graph before the Host has written one", async () => {
    const response = await handlePluginRequest("/profile", "pigcode-plugin://boot.json/", files({}))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ entries: [] })
  })

  it("serves boot.json and plugin bundles from the profile", async () => {
    const read = files({
      "/profile/boot.json": '{"entries":[{"id":"ui.demo"}]}',
      "/profile/node_modules/pigcode-ui-demo/client.mjs": "export function apply() {}",
    })
    expect(
      await (await handlePluginRequest("/profile", "pigcode-plugin://boot.json/", read)).json(),
    ).toEqual({
      entries: [{ id: "ui.demo" }],
    })
    const bundle = await handlePluginRequest(
      "/profile",
      "pigcode-plugin://plugins/pigcode-ui-demo/client.mjs?rev=abc",
      read,
    )
    expect(bundle.headers.get("content-type")).toBe("text/javascript")
    expect(await bundle.text()).toBe("export function apply() {}")
  })

  it("answers 404 for missing files and never serves paths outside the plugin", async () => {
    const read = files({ "/secret": "nope", "/profile/secret": "nope" })
    expect(
      (await handlePluginRequest("/profile", "pigcode-plugin://plugins/demo/missing.mjs", read))
        .status,
    ).toBe(404)
    expect(
      (await handlePluginRequest("/profile", "pigcode-plugin://plugins/demo/../../../secret", read))
        .status,
    ).toBe(404)
    expect(
      (
        await handlePluginRequest(
          "/profile",
          "pigcode-plugin://plugins/demo/..%2F..%2Fsecret",
          read,
        )
      ).status,
    ).toBe(404)
    expect((await handlePluginRequest("/profile", "pigcode-plugin://other/x", read)).status).toBe(
      404,
    )
  })
})
