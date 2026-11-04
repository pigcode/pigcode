/** 验证插件模块的 apply 与清理。 */
import type { ClientPluginContext, ClientTheme, ClientUiKit } from "@pigcode/plugin-sdk"
import { describe, expect, it, vi } from "vitest"
import { applyClientPlugin } from "./modules"

/** 什么也不做的插件上下文。 */
function stubContext(): ClientPluginContext {
  const fixed = <T>(value: T) => ({ get: () => value, subscribe: () => () => {} })
  return {
    host: { call: async () => undefined },
    panels: { register: () => () => {} },
    surfaces: { register: () => () => {} },
    settingsPages: { register: () => () => {} },
    commands: { register: () => () => {} },
    ui: {} as ClientUiKit,
    theme: fixed<ClientTheme>("light"),
    locale: fixed("zh-CN"),
  }
}

describe("applyClientPlugin", () => {
  it("applies a client plugin and returns its cleanup", () => {
    const dispose = vi.fn()
    const ctx = stubContext()
    const applied = vi.fn(() => dispose)
    const cleanup = applyClientPlugin({ apply: applied }, ctx)
    expect(applied).toHaveBeenCalledWith(ctx)
    cleanup()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it("returns a no-op cleanup when the module has no apply or apply returns nothing", () => {
    expect(() => applyClientPlugin({}, stubContext())()).not.toThrow()
    expect(() => applyClientPlugin({ apply: () => undefined }, stubContext())()).not.toThrow()
  })
})
