import type { PluginHostContext } from "@pigcode/plugin-sdk"
import { OpenCodeDriver } from "./driver"

export const name = "agent-opencode"
export const inject = ["agents"]
export function apply(ctx: PluginHostContext) {
  const driver = new OpenCodeDriver()
  ctx.agents.register(driver)
  ctx.effect(() => async () => {
    ctx.agents.unregister(driver.id)
    await driver.close()
  })
}
