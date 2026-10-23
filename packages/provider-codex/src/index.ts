/** Codex agent 插件：向 Host 注册 driver；停用或卸载时注销并关闭它启动的 app-server。 */
import type { PluginHostContext } from "@pigcode/plugin-sdk"
import { CodexDriver } from "./driver"

export const name = "provider-codex"
export const inject = ["providers"]

export function apply(ctx: PluginHostContext): void {
  const driver = new CodexDriver()
  ctx.providers.register(driver)
  ctx.effect(() => () => {
    ctx.providers.unregister(driver.id)
    driver.close()
  })
}
