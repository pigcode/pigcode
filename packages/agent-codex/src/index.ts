/** Codex agent 插件：向 Host 注册 driver；停用或卸载时注销并关闭它启动的 app-server。 */
import type { PluginHostContext } from "@pigcode/plugin-sdk"
import { CodexDriver } from "./driver"

export const name = "agent-codex"
export const inject = ["agents"]

export function apply(ctx: PluginHostContext): void {
  const driver = new CodexDriver()
  ctx.agents.register(driver)
  ctx.effect(() => async () => {
    ctx.agents.unregister(driver.id)
    await driver.close()
  })
}
