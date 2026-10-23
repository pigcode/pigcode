/** Claude Code agent 插件：向 Host 注册 driver；停用或卸载时注销并结束它启动的 CLI 进程。 */
import type { PluginHostContext } from "@pigcode/plugin-sdk"
import { ClaudeDriver } from "./driver"

export const name = "provider-claude"
export const inject = ["providers"]

export function apply(ctx: PluginHostContext): void {
  const driver = new ClaudeDriver()
  ctx.providers.register(driver)
  ctx.effect(() => () => {
    ctx.providers.unregister(driver.id)
    driver.close()
  })
}
