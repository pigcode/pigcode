import type { PluginHostContext } from "@pigcode/plugin-sdk"
import { PiDriver } from "./driver"
export const name = "agent-pi"
export const inject = ["agents"]
export function apply(ctx: PluginHostContext) {
  const driver = new PiDriver()
  ctx.agents.register(driver)
  ctx.effect(() => async () => {
    ctx.agents.unregister(driver.id)
    await driver.close()
  })
}
