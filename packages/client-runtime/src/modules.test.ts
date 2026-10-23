/** 验证 boot graph 加载、apply 与卸载。 */
import type { ClientPluginContext, ClientTheme, ClientUiKit } from "@pigcode/plugin-sdk"
import { describe, expect, it, vi } from "vitest"
import { loadClientPlugins } from "./modules"

/** 什么也不做的插件上下文。 */
function stubContext(): ClientPluginContext {
  const fixed = <T>(value: T) => ({ get: () => value, subscribe: () => () => {} })
  return {
    slots: { register: () => () => {} },
    host: { call: async () => undefined },
    registerPanel: () => () => {},
    registerSurface: () => () => {},
    ui: {} as ClientUiKit,
    theme: fixed<ClientTheme>("light"),
    locale: fixed("zh-CN"),
  }
}

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
        return stubContext()
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
      context: stubContext,
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
