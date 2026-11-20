import type { PluginHostContext } from "@pigcode/plugin-sdk"
import { AcpDriver } from "./driver"

export const name = "agent-acp"
export const inject = ["agents"]

export function apply(ctx: PluginHostContext): void {
  const driver = new AcpDriver()
  ctx.agents.register(driver)
  ctx.effect(() => async () => {
    ctx.agents.unregister(driver.id)
    await driver.close()
  })
}
