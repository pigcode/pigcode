/** Claude Code agent 插件：向 Host 注册 driver；停用或卸载时注销并结束它启动的 CLI 进程。 */
import type { PluginHostContext } from "@pigcode/plugin-sdk"
import { ClaudeDriver } from "./driver"

export const name = "agent-claude"
export const inject = ["agents"]

export function apply(ctx: PluginHostContext): void {
  const driver = new ClaudeDriver()
  ctx.agents.register(driver)
  ctx.effect(() => async () => {
    ctx.agents.unregister(driver.id)
    await driver.close()
  })
}
