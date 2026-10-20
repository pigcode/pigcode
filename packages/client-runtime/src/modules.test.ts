/** 验证 boot graph 加载、apply 与卸载。 */
import { describe, expect, it, vi } from "vitest"
import { loadClientPlugins } from "./modules"

describe("loadClientPlugins", () => {
  it("applies and disposes a client plugin", async () => {
    const dispose = vi.fn()
    const applied = vi.fn(() => dispose)
    const load = vi.fn(async () => ({ apply: applied }))
    const contextIds: string[] = []
    const result = await loadClientPlugins({
      boot: {
        entries: [
          { id: "demo", url: "pigcode-plugin://demo/client.js", revision: "1", inject: [] },
        ],
      },
      load,
      context: (entry) => {
        contextIds.push(entry.id)
        return {
          slots: { register: () => () => {} },
          host: { call: async () => undefined },
          registerPanel: () => () => {},
        }
      },
    })
    expect(applied).toHaveBeenCalledOnce()
    expect(contextIds).toEqual(["demo"])
    result.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it("loads in boot order and disposes in reverse order", async () => {
    const calls: string[] = []
    const result = await loadClientPlugins({
      boot: {
        entries: [
          { id: "first", url: "pigcode-plugin://first/client.js", revision: "1", inject: [] },
          { id: "second", url: "pigcode-plugin://second/client.js", revision: "1", inject: [] },
        ],
      },
      load: async (url) => ({
        apply: () => {
          calls.push(url)
          return () => calls.push(`dispose:${url}`)
        },
      }),
      context: () => ({
        slots: { register: () => () => {} },
        host: { call: async () => undefined },
        registerPanel: () => () => {},
      }),
    })

    result.dispose()
    expect(calls).toEqual([
      "pigcode-plugin://first/client.js",
      "pigcode-plugin://second/client.js",
      "dispose:pigcode-plugin://second/client.js",
      "dispose:pigcode-plugin://first/client.js",
    ])
  })
})
